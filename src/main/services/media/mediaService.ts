import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { getMediaCacheDir } from '../paths'
import { getConfig } from '../../db/repos/config'
import * as keyRepo from '../../db/repos/keyStore'
import {
  decryptDatFile,
  detectImageExtension,
  extractWxgfViewable,
  isWxgf,
  parseAesKey,
  parseXorKey
} from './datDecrypt'

/**
 * 微信媒体（图片 .dat）解密服务（M3 图片消费方）。
 *
 * 微信 4.x 图片附件位于 xwechat_files 数据目录 msg/attach 下的 Img 子目录，文件名为
 * - &lt;md5&gt;.dat       原图（V1/V2 加密，解密后多为 wxgf/HEVC 或内嵌 JPEG）
 * - &lt;md5&gt;_t.dat     缩略图（解密后通常为 JPEG，可直接展示）
 * - &lt;md5&gt;_h.dat     高清图
 *
 * 密钥来自设置页 img:{wxid}:xorKey / img:{wxid}:aesKey（外部注入），
 * 明文 key 不落盘：仅每次解密时从 app_config 读取内存使用。
 *
 * 返回 URL 为 ct-media://media/&lt;wxid&gt;/&lt;文件名&gt;（主进程 media 协议映射到缓存目录），
 * 保证 dev（http）与生产（file）两种渲染源都能加载。
 */

export interface DecryptImageOptions {
  /** 归属账号 wxid（用于读取密钥与定位数据目录） */
  wxid: string
  /** 消息中的图片 md5 */
  imageMd5: string
  /** 文件种类：orig=原图 thumb=缩略图 hd=高清（默认 orig） */
  kind?: 'orig' | 'thumb' | 'hd'
  /** 微信数据根路径（xwechat_files 上级目录）；缺省尝试 key_store 中的 db_path */
  dbPath?: string
}

export interface DecryptImageResult {
  ok: boolean
  url?: string
  ext?: string
  source?: 'cache' | 'new'
  error?: string
}

/** media 协议 URL 前缀（与主进程 protocol.handle('ct-media') 约定一致） */
export const MEDIA_URL_BASE = 'ct-media://media'

export function toMediaUrl(wxid: string, fileName: string): string {
  return `${MEDIA_URL_BASE}/${encodeURIComponent(wxid)}/${encodeURIComponent(fileName)}`
}

/** 目录列表短缓存：一张图要查 orig/thumb/hd 三次，逐次 readdir 是纯浪费 */
const dirListCache = new Map<string, { at: number; names: string[] }>()
const DIR_LIST_TTL_MS = 5000

function listDirNames(dir: string): string[] {
  const hit = dirListCache.get(dir)
  if (hit && Date.now() - hit.at < DIR_LIST_TTL_MS) return hit.names
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    names = []
  }
  if (dirListCache.size >= 16) dirListCache.clear()
  dirListCache.set(dir, { at: Date.now(), names })
  return names
}

/** 缓存目录快照：查找已解出的 <md5>_<kind>.* 文件（命中即跳过重新扫描/解密，返回文件名） */
function findCachedMedia(wxid: string, md5: string, kind: 'orig' | 'thumb' | 'hd'): string | null {
  const cacheDir = getMediaCacheDir(wxid)
  const prefix = `${md5}_${kind}.`
  for (const name of listDirNames(cacheDir)) {
    if (name.toLowerCase().startsWith(prefix)) return name
  }
  return null
}

/**
 * 附件目录的文件名索引（小写文件名 -> 绝对路径）。
 * 解密一张图此前要遍历整棵 attach 树（最多 5000 个目录），逐张调用即 O(请求数 × 文件数)；
 * 建索引后命中是 O(1)，未命中时刷新一次索引再试（新落地的文件也能找到）。
 */
const mediaIndexCache = new Map<string, Map<string, string>>()

function walkFiles(root: string, visit: (full: string, name: string) => boolean): string | null {
  const stack: string[] = [root]
  let guard = 0
  while (stack.length > 0 && guard < 5000) {
    guard++
    const dir = stack.pop()!
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (visit(full, e.name)) return full
    }
  }
  return null
}

function mediaIndex(root: string, refresh = false): Map<string, string> {
  const hit = mediaIndexCache.get(root)
  if (hit && !refresh) return hit
  const idx = new Map<string, string>()
  walkFiles(root, (full, name) => {
    idx.set(name.toLowerCase(), full)
    return false
  })
  if (mediaIndexCache.size >= 8) mediaIndexCache.clear()
  mediaIndexCache.set(root, idx)
  return idx
}

/**
 * 解析外部 ffmpeg：app_config(media.ffmpegPath) > 环境变量 WECHAT_CS_FFMPEG > PATH 上的 ffmpeg。
 * 找不到可用二进制时返回 'ffmpeg'（交给 spawn 报 ENOENT 自然失败）。
 */
export function resolveFfmpeg(): string {
  const cfg = getConfig('media.ffmpegPath')?.trim()
  if (cfg) {
    if (existsSync(cfg)) return cfg
    return cfg // 显式配置即使失效也如实尝试，便于用户发现路径填错
  }
  const envPath = process.env.WECHAT_CS_FFMPEG?.trim()
  if (envPath && existsSync(envPath)) return envPath
  return 'ffmpeg'
}

/** 定位 attach 根目录：<wxid>/msg/attach 或 <dbPath>/msg/attach */
function findAttachRoot(basePath: string, wxid: string): string | null {
  const candidates = [join(basePath, wxid, 'msg', 'attach'), join(basePath, 'msg', 'attach')]
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isDirectory()) return c
  }
  return null
}

/** 深度遍历目录树，返回首个匹配 md5 的 .dat 文件（match 后缀：'' | '_t' | '_h'，兼容 hd/thumb 变体） */
function findDatByMd5(root: string, md5: string, suffix: string): string | null {
  // 各 kind 的可接受文件名（小写，不含扩展名）
  const base = md5.toLowerCase()
  const accept: string[] =
    suffix === '_t'
      ? [`${base}_t`, `${base}.t`, `${base}_thumb`]
      : suffix === '_h'
        ? [`${base}_h`, `${base}.h`, `${base}_hd`]
        : [base]
  const probe = (idx: Map<string, string>): string | null => {
    for (const stem of accept) {
      const hit = idx.get(`${stem}.dat`)
      if (hit) return hit
    }
    return null
  }
  // 命中索引直接返回；未命中刷新一次（文件可能刚落地）
  return probe(mediaIndex(root)) ?? probe(mediaIndex(root, true))
}

/**
 * 解密图片 .dat → 写入缓存目录 → 返回 ct-media:// URL。
 * 缩略图优先（_t.dat 多为 JPEG 可直接用）；原图为纯 HEVC 时用 ffmpeg 转 JPEG。
 */
export async function decryptImage(opts: DecryptImageOptions): Promise<DecryptImageResult> {
  const wxid = opts.wxid?.trim()
  const md5 = opts.imageMd5?.trim().toLowerCase()
  if (!wxid || !md5 || !/^[0-9a-f]{32}$/.test(md5)) {
    return { ok: false, error: '缺少有效的 wxid / imageMd5' }
  }

  // 1. 定位 attach 根目录
  const xorRaw = getConfig(`img:${wxid}:xorKey`)
  const aesRaw = getConfig(`img:${wxid}:aesKey`)
  const dbPath = opts.dbPath?.trim()

  let attachRoot: string | null = null
  if (dbPath) attachRoot = findAttachRoot(dbPath, wxid)
  // 缺省回退到 key_store 中记录的微信数据根路径
  if (!attachRoot) {
    const profile = keyRepo.getKey(wxid)
    if (profile?.dbPath) attachRoot = findAttachRoot(profile.dbPath, wxid)
  }
  if (!attachRoot) {
    return {
      ok: false,
      error: '未找到微信图片附件目录 msg/attach（请先连接账号或配置数据路径）'
    }
  }

  // 2. 无密钥无法解密（V3 纯 XOR 或 V1 固定 AES 也需 XOR key）
  const xorKey = parseXorKey(xorRaw)
  const aesKey = parseAesKey(aesRaw)
  if (xorKey === null && aesKey === null) {
    return { ok: false, error: '未配置图片解密密钥，请到 设置 → 图片解密 填写' }
  }

  // 3. 逐 kind 查找并解密：解密失败（如 wxgf 不可用）时继续尝试下一级
  const kind = opts.kind ?? 'orig'
  const suffixFor = (k: 'orig' | 'thumb' | 'hd'): string =>
    k === 'thumb' ? '_t' : k === 'hd' ? '_h' : ''
  const order: Array<'orig' | 'thumb' | 'hd'> =
    kind === 'thumb'
      ? ['thumb', 'orig', 'hd']
      : kind === 'hd'
        ? ['hd', 'orig', 'thumb']
        : ['orig', 'thumb', 'hd']

  let lastMiss = ''
  let lastFail = ''
  for (const k of order) {
    // 缓存快路径：已解出过则直接返回，避免每次打开会话都重扫目录树 + 重解密
    const cached = findCachedMedia(wxid, md5, k)
    if (cached) {
      const ext = extname(cached).slice(1)
      return { ok: true, url: toMediaUrl(wxid, cached), ext, source: 'cache' }
    }
    const datPath = findDatByMd5(attachRoot, md5, suffixFor(k))
    if (!datPath) {
      lastMiss = lastMiss || `未找到 ${md5}${suffixFor(k)}.dat`
      continue
    }
    const tried = await tryDecryptOne(datPath, wxid, xorKey, aesKey, md5, k)
    if (tried.ok) return tried
    lastFail = tried.error || lastFail
  }
  return {
    ok: false,
    error: lastFail || lastMiss || `微信附件目录中未找到 ${md5} 的 .dat 文件`
  }
}

/** 解密单个 dat → 缓存 → ct-media:// URL（不成功返回错误） */
async function tryDecryptOne(
  datPath: string,
  wxid: string,
  xorKey: number | null,
  aesKey: Buffer | null,
  md5: string,
  foundKind: 'orig' | 'thumb' | 'hd'
): Promise<DecryptImageResult> {
  try {
    const { data } = decryptDatFile(datPath, xorKey, aesKey)

    // 解密后处理：wxgf 优先内嵌 JPEG/PNG；纯 HEVC 时用 ffmpeg 转 JPEG 首帧
    let finalData = data
    let ext = detectImageExtension(finalData)
    if (!ext && isWxgf(finalData)) {
      const viewable = await extractWxgfViewable(finalData, resolveFfmpeg())
      if (viewable) {
        finalData = viewable
        ext = detectImageExtension(finalData)
      }
    }
    if (!ext) {
      return {
        ok: false,
        error: `${md5}_${foundKind} 为纯 HEVC 原图（wxgf），需 ffmpeg 转码；请在设置中配置 ffmpeg 路径`
      }
    }

    // 写入缓存目录 media/<wxid>/<md5>_<kind><ext>
    const cacheDir = getMediaCacheDir(wxid)
    mkdirSync(cacheDir, { recursive: true })
    const cacheName = `${md5}_${foundKind}${ext}`
    const cacheFile = join(cacheDir, cacheName)
    writeFileSync(cacheFile, finalData)
    return { ok: true, url: toMediaUrl(wxid, cacheName), ext, source: 'new' }
  } catch (e) {
    return {
      ok: false,
      error: `${md5}_${foundKind} 解密失败: ${e instanceof Error ? e.message : String(e)}`
    }
  }
}

/** 找 attach 目录下第一个 <md5>[_t|_h].dat（用于测试密钥），返回其 md5 */
function findFirstDatMd5(root: string): { md5: string; suffix: string } | null {
  const stack: string[] = [root]
  let guard = 0
  while (stack.length > 0 && guard < 5000) {
    guard++
    const dir = stack.pop()!
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        stack.push(full)
      } else {
        const m = /^([0-9a-f]{32})(_t|_h)?\.dat$/i.exec(e.name)
        if (m) return { md5: m[1], suffix: m[2] ?? '' }
      }
    }
  }
  return null
}

/**
 * 测试图片密钥：从当前账号 attach 目录取一张图实际解密，
 * 用于设置页「测试解密一张图片」验证 XOR/AES 密钥是否正确。
 */
export async function testImageDecrypt(wxid: string, dbPath?: string): Promise<DecryptImageResult> {
  const id = wxid?.trim()
  if (!id) return { ok: false, error: '缺少 wxid' }
  const xorKey = parseXorKey(getConfig(`img:${id}:xorKey`))
  const aesKey = parseAesKey(getConfig(`img:${id}:aesKey`))
  if (xorKey === null && aesKey === null) {
    return { ok: false, error: '未配置图片解密密钥，请先保存' }
  }

  let attachRoot: string | null = null
  if (dbPath?.trim()) attachRoot = findAttachRoot(dbPath.trim(), id)
  if (!attachRoot) {
    const profile = keyRepo.getKey(id)
    if (profile?.dbPath) attachRoot = findAttachRoot(profile.dbPath, id)
  }
  if (!attachRoot) {
    return { ok: false, error: '未找到微信图片附件目录 msg/attach' }
  }

  const hit = findFirstDatMd5(attachRoot)
  if (!hit) {
    return { ok: false, error: 'attach 目录中未找到任何 .dat 图片文件' }
  }

  const result = await decryptImage({ wxid: id, imageMd5: hit.md5, kind: 'orig', dbPath })
  if (result.ok) {
    return {
      ok: true,
      url: result.url,
      ext: result.ext,
      error: `找到 ${hit.md5} 并成功解密`
    }
  }
  // 原图失败可退回缩略图再试一次（缩略图多为 JPEG 更易成功）
  const thumbResult = await decryptImage({ wxid: id, imageMd5: hit.md5, kind: 'thumb', dbPath })
  if (thumbResult.ok) {
    return {
      ok: true,
      url: thumbResult.url,
      ext: thumbResult.ext,
      error: `原图 ${result.error}；已用缩略图验证成功`
    }
  }
  return { ok: false, error: `解密失败：${result.error}` }
}

export interface DecryptVideoOptions {
  /** 归属账号 wxid */
  wxid: string
  /** 消息中的视频文件名 md5（来自 packed_info_data） */
  videoMd5: string
  /** 微信数据根路径；缺省尝试 key_store 中的 db_path */
  dbPath?: string
}

export interface DecryptVideoResult {
  ok: boolean
  url?: string
  error?: string
}

/** 定位视频目录：<wxid>/msg/video 或 <dbPath>/msg/video */
function findVideoRoot(basePath: string, wxid: string): string | null {
  const candidates = [join(basePath, wxid, 'msg', 'video'), join(basePath, 'msg', 'video')]
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isDirectory()) return c
  }
  return null
}

/** 视频附件支持的后缀（微信视频落地即明文 MP4，无 .dat 加密） */
const VIDEO_EXTS = ['.mp4', '.mkv', '.avi', '.mov', '.m4v']

/** 深度遍历 msg/video，返回首个文件名 md5 匹配的视频文件 */
function findVideoByMd5(root: string, md5: string): string | null {
  const base = md5.toLowerCase()
  const probe = (idx: Map<string, string>): string | null => {
    for (const ext of VIDEO_EXTS) {
      const hit = idx.get(`${base}${ext}`)
      if (hit) return hit
    }
    return null
  }
  return probe(mediaIndex(root)) ?? probe(mediaIndex(root, true))
}

/**
 * 解析视频 → 拷贝到缓存目录 → 返回 ct-media:// URL（渲染端可用 <video> 播放）。
 * 微信 4.x 视频附件落地在 msg/video/<年月>/<md5>.mp4，本身已是明文 MP4，无需解密。
 */
export async function decryptVideo(opts: DecryptVideoOptions): Promise<DecryptVideoResult> {
  const wxid = opts.wxid?.trim()
  const md5 = opts.videoMd5?.trim().toLowerCase()
  if (!wxid || !md5 || !/^[0-9a-f]{32}$/.test(md5)) {
    return { ok: false, error: '缺少有效的 wxid / videoMd5' }
  }

  const dbPath = opts.dbPath?.trim()

  let videoRoot: string | null = null
  if (dbPath) videoRoot = findVideoRoot(dbPath, wxid)
  if (!videoRoot) {
    const profile = keyRepo.getKey(wxid)
    if (profile?.dbPath) videoRoot = findVideoRoot(profile.dbPath, wxid)
  }
  if (!videoRoot) {
    return { ok: false, error: '未找到微信视频目录 msg/video（请先连接账号或配置数据路径）' }
  }

  const srcPath = findVideoByMd5(videoRoot, md5)
  if (!srcPath) {
    return { ok: false, error: `未找到视频文件 ${md5}（可能已被微信清理）` }
  }

  try {
    const ext = extname(srcPath).toLowerCase()
    const cacheDir = getMediaCacheDir(wxid)
    mkdirSync(cacheDir, { recursive: true })
    const cacheName = `${md5}_video${ext}`
    const cacheFile = join(cacheDir, cacheName)
    if (!existsSync(cacheFile)) {
      copyFileSync(srcPath, cacheFile)
    }
    return { ok: true, url: toMediaUrl(wxid, cacheName) }
  } catch (e) {
    return {
      ok: false,
      error: `${md5} 视频读取失败: ${e instanceof Error ? e.message : String(e)}`
    }
  }
}
