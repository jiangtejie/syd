import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { getMediaCacheDir } from '../paths'
import { getConfig } from '../../db/repos/config'
import * as keyRepo from '../../db/repos/keyStore'
import { createLogger } from '../logging'
import { openSecret } from '../secrets'
import { describeFfmpeg, pickFfmpegPath, type FfmpegCandidates } from './ffmpegPath'
import type { FfmpegStatus } from '../../../shared/ffmpeg'
import { app } from 'electron'
import {
  decryptDatFile,
  detectImageExtension,
  extractWxgfViewableDetailed,
  isWxgf,
  parseAesKey,
  parseXorKey
} from './datDecrypt'
import {
  degradedReasonText,
  normalizeKind,
  tierLabel,
  tierSuffix,
  tierOrder,
  type ImageDegradedReason,
  type ImageKind,
  type ImageTier
} from '../../../shared/imageTier'

const mediaLog = createLogger('media')

/** 随包 ffmpeg 的文件名（Windows 上是 .exe；其余平台按同名可执行文件处理） */
const FFMPEG_BIN = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'

/**
 * 微信媒体（图片 .dat）解密服务（M3 图片消费方）。
 *
 * 微信 4.x 图片附件位于 xwechat_files 数据目录 msg/attach 下的 Img 子目录，文件名为
 * - &lt;md5&gt;.dat       默认图（V1/V2 加密，解密后多为 wxgf/HEVC 或内嵌 JPEG）
 * - &lt;md5&gt;_t.dat     缩略图（解密后通常为 JPEG，可直接展示）
 * - &lt;md5&gt;_h.dat     高清原图（要在客户端点开「查看原图」才会落地）
 *
 * **档位优先级**：请求语义与尝试顺序由 shared/imageTier 决定（默认 best = 高清 → 默认 → 缩略图），
 * 实际命中的档位由 foundKind 回传 —— 早先 orig 的兜底把缩略图排在高清前面，且回退后不告诉调用方，
 * 大图预览/飞书证据/上报归档会把缩略图当原图用（详见 shared/imageTier.ts 注释）。
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
  /** 文件种类：best=最好可用（默认）/ orig=默认图 / thumb=缩略图 / hd=高清原图 */
  kind?: ImageKind
  /** 微信数据根路径（xwechat_files 上级目录）；缺省尝试 key_store 中的 db_path */
  dbPath?: string
}

export interface DecryptImageResult {
  ok: boolean
  url?: string
  ext?: string
  /** 实际命中的档位：回退成功时也如实回传，调用方据此标注「缩略图/默认图/高清原图」 */
  foundKind?: ImageTier
  /**
   * 降级原因：本来有更好的一档、却因为「可修复」的问题没拿到时一并回传
   * （目前是 ffmpeg 缺失/解不出 HEVC）。界面据此给出可执行提示，日志也会记一条（同一张图只记一次）。
   */
  degradedReason?: ImageDegradedReason
  source?: 'cache' | 'new'
  error?: string
}

/** media 协议 URL 与解析规则都收在 mediaProtocol（纯函数，可自检）；这里转出以保持既有引用路径 */
import { MEDIA_URL_BASE, toMediaUrl, toVoiceMediaUrl } from './mediaProtocol'
export { MEDIA_URL_BASE, toMediaUrl, toVoiceMediaUrl }

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
function findCachedMedia(wxid: string, md5: string, kind: ImageTier): string | null {
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
 * 随包 ffmpeg 的路径（electron-builder extraResources: resources/bin → resourcesPath/bin）。
 * 与 injector.scriptPath() 同一套打包/开发分支写法。
 */
export function bundledFfmpegPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'bin', FFMPEG_BIN)
    : join(app.getAppPath(), 'resources', 'bin', FFMPEG_BIN)
}

/** 收集四个候选（只做存在性探测；体积/版本这类只有设置页才需要的 IO 不在这里做） */
function ffmpegCandidates(): FfmpegCandidates {
  const configured = getConfig('media.ffmpegPath')?.trim() ?? ''
  const envPath = process.env.WECHAT_CS_FFMPEG?.trim() ?? ''
  const bundled = bundledFfmpegPath()
  return {
    configured,
    // 显式配置即使失效也如实尝试（便于用户发现填错），所以这里的存在性只用于日志语义
    configuredExists: !!configured && existsSync(configured),
    envPath,
    envExists: !!envPath && existsSync(envPath),
    bundled,
    bundledExists: existsSync(bundled)
  }
}

/**
 * 解析外部 ffmpeg：app_config(media.ffmpegPath) > 环境变量 WECHAT_CS_FFMPEG > **随包** > PATH。
 * 找不到可用二进制时返回 'ffmpeg'（交给 spawn 报 ENOENT 自然失败）。
 * 判定逻辑在 media/ffmpegPath.ts（纯函数，有自检）。
 */
export function resolveFfmpeg(): string {
  return pickFfmpegPath(ffmpegCandidates())
}

/** 随包 ffmpeg 的版本：从 prepare-ffmpeg.mjs 生成的 NOTICE.md 里读，读不到就当不知道 */
function bundledFfmpegVersion(): string | null {
  try {
    const txt = readFileSync(join(dirname(bundledFfmpegPath()), 'NOTICE.md'), 'utf8')
    const row = txt.match(/^\|\s*版本\s*\|\s*(.+?)\s*\|\s*$/m)
    if (!row) return null
    // "ffmpeg version 9.0.1-full_build-www.gyan.dev Copyright (c) …" → 只留版本号
    const v = row[1].match(/ffmpeg version (\S+)/)
    return v ? v[1] : row[1].slice(0, 60)
  } catch {
    return null
  }
}

/**
 * ffmpeg 的解析现状（设置页用）。
 *
 * 与 resolveFfmpeg 分开：那个在每次图片解密的热路径上，只该做最便宜的判定；
 * 这里会读文件体积与 NOTICE.md，只在打开设置页 / 保存覆盖路径后才调。
 */
export function ffmpegStatus(): FfmpegStatus {
  const c = ffmpegCandidates()
  const pick = describeFfmpeg(c)
  let sizeMb: number | null = null
  if (c.bundledExists) {
    try {
      sizeMb = Math.round((statSync(c.bundled).size / 1024 / 1024) * 10) / 10
    } catch {
      sizeMb = null
    }
  }
  return {
    path: pick.path,
    source: pick.source,
    bundled: {
      path: c.bundled,
      exists: c.bundledExists,
      sizeMb,
      version: c.bundledExists ? bundledFfmpegVersion() : null
    },
    configured: c.configured,
    configuredExists: c.configuredExists,
    envPath: c.envPath,
    envExists: c.envExists
  }
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
 * 解密图片 .dat → 写入缓存目录 → 返回 ct-media:// URL（含实际命中的档位 foundKind）。
 * 按 tierOrder(kind) 由好到差逐级尝试；纯 HEVC 的档位用 ffmpeg 转 JPEG。
 */
export async function decryptImage(opts: DecryptImageOptions): Promise<DecryptImageResult> {
  const wxid = opts.wxid?.trim()
  const md5 = opts.imageMd5?.trim().toLowerCase()
  if (!wxid || !md5 || !/^[0-9a-f]{32}$/.test(md5)) {
    return { ok: false, error: '缺少有效的 wxid / imageMd5' }
  }

  // 1. 定位 attach 根目录
  // 图片密钥加封存储（enc1:），读侧统一开封：见 securityPolicy.isSecretConfigKey
  const xorRaw = openSecret(getConfig(`img:${wxid}:xorKey`))
  const aesRaw = openSecret(getConfig(`img:${wxid}:aesKey`))
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

  // 3. 按档位优先级由好到差查找并解密：某一档缺失/解密失败（如 wxgf 不可用）继续下一级
  const order = tierOrder(normalizeKind(opts.kind))

  let lastMiss = ''
  let lastFail = ''
  // 逐级尝试时记下「本来能更好」的原因，回退成功后一并带回（否则用户只看到一张糊图，无从下手）
  let degradedReason: ImageDegradedReason | undefined
  for (const k of order) {
    // 缓存快路径：已解出过则直接返回，避免每次打开会话都重扫目录树 + 重解密
    const cached = findCachedMedia(wxid, md5, k)
    if (cached) {
      const ext = extname(cached).slice(1)
      return { ok: true, url: toMediaUrl(wxid, cached), ext, foundKind: k, source: 'cache' }
    }
    const datPath = findDatByMd5(attachRoot, md5, tierSuffix(k))
    if (!datPath) {
      lastMiss = lastMiss || `未找到 ${md5}${tierSuffix(k)}.dat`
      continue
    }
    const tried = await tryDecryptOne(datPath, wxid, xorKey, aesKey, md5, k)
    if (tried.ok) {
      // 命中档位不是首选档 = 确实降级了，才把原因带出去（列表气泡要 thumb，就不算降级）
      if (degradedReason && k !== order[0]) {
        warnDegradedOnce(wxid, md5, k, degradedReason)
        return { ...tried, degradedReason }
      }
      return tried
    }
    degradedReason = degradedReason ?? tried.degradedReason
    lastFail = tried.error || lastFail
  }
  if (degradedReason) warnDegradedOnce(wxid, md5, undefined, degradedReason)
  return {
    ok: false,
    degradedReason,
    error: lastFail || lastMiss || `微信附件目录中未找到 ${md5} 的 .dat 文件`
  }
}

/**
 * 降级告警：同一张图只记一次（列表滚动会把同一张图问很多遍），避免把日志刷满。
 * 这条日志是「用户在群里看到糊图 → 运维能直接查到原因」的唯一线索：以前整条链路完全静默，
 * 只能靠肉眼发现图糊了。
 */
const degradedWarned = new Set<string>()
function warnDegradedOnce(
  wxid: string,
  md5: string,
  foundKind: ImageTier | undefined,
  reason: ImageDegradedReason
): void {
  const key = `${wxid}:${md5}:${reason}`
  if (degradedWarned.has(key)) return
  if (degradedWarned.size > 500) degradedWarned.clear()
  degradedWarned.add(key)
  mediaLog.warn(
    `图片降级为${foundKind ? tierLabel(foundKind) : '不可用'}（${md5.slice(0, 8)}…，账号 ${wxid}）：${degradedReasonText(reason)}`
  )
}

/** 解密单个 dat → 缓存 → ct-media:// URL（不成功返回错误） */
async function tryDecryptOne(
  datPath: string,
  wxid: string,
  xorKey: number | null,
  aesKey: Buffer | null,
  md5: string,
  foundKind: ImageTier
): Promise<DecryptImageResult> {
  try {
    const { data } = decryptDatFile(datPath, xorKey, aesKey)

    // 解密后处理：wxgf 优先内嵌 JPEG/PNG；纯 HEVC 时用 ffmpeg 转 JPEG 首帧
    let finalData = data
    let ext = detectImageExtension(finalData)
    let degradedReason: ImageDegradedReason | undefined
    if (!ext && isWxgf(finalData)) {
      const viewable = await extractWxgfViewableDetailed(finalData, resolveFfmpeg())
      if (viewable.data) {
        finalData = viewable.data
        ext = detectImageExtension(finalData)
      } else {
        // 分清「没配 ffmpeg」和「配了也解不出」——前者是可修复的，界面要给出可执行提示
        degradedReason = viewable.reason === 'no-ffmpeg' ? 'ffmpeg-missing' : 'hevc-decode-failed'
      }
    }
    if (!ext) {
      return {
        ok: false,
        degradedReason,
        error: `${md5}_${foundKind} 为纯 HEVC 原图（wxgf），${degradedReason ? degradedReasonText(degradedReason) : '解不出可视画面'}`
      }
    }

    // 写入缓存目录 media/<wxid>/<md5>_<kind><ext>
    const cacheDir = getMediaCacheDir(wxid)
    mkdirSync(cacheDir, { recursive: true })
    const cacheName = `${md5}_${foundKind}${ext}`
    const cacheFile = join(cacheDir, cacheName)
    writeFileSync(cacheFile, finalData)
    return { ok: true, url: toMediaUrl(wxid, cacheName), ext, foundKind, source: 'new' }
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
  const xorKey = parseXorKey(openSecret(getConfig(`img:${id}:xorKey`)))
  const aesKey = parseAesKey(openSecret(getConfig(`img:${id}:aesKey`)))
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

  // best = 高清 → 默认 → 缩略图，逐级兜底在 decryptImage 内部完成，这里只如实报命中档位
  const result = await decryptImage({ wxid: id, imageMd5: hit.md5, kind: 'best', dbPath })
  if (result.ok) {
    const degraded = result.degradedReason
      ? `；注意：${degradedReasonText(result.degradedReason)}`
      : ''
    return {
      ok: true,
      url: result.url,
      ext: result.ext,
      foundKind: result.foundKind,
      degradedReason: result.degradedReason,
      error: `找到 ${hit.md5} 并成功解密（${tierLabel(result.foundKind)}）${degraded}`
    }
  }
  return {
    ok: false,
    degradedReason: result.degradedReason,
    error: `解密失败：${result.error}`
  }
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
