import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigNumber } from '../../db/repos/config'
import { openWxDbFile } from '../wechat/decrypt'
import { locateWeChatDbs } from '../wechat/dbLocator'
import { toVoiceMediaUrl } from './mediaProtocol'
import { getMediaCacheDir } from '../paths'
import * as keyRepo from '../../db/repos/keyStore'
import { createLogger } from '../logging'

const voiceLog = createLogger('media')

/**
 * 语音消息解密：微信 4.x 把语音 SILK 数据存在 `db_storage/message/media_*.db` 的 `VoiceInfo` 表里，
 * 需要用 `silk-wasm` 解码成 PCM 再包成 WAV。
 *
 * 为什么值得做：此前语音在整条链路里只是 `[语音]` 占位 —— 证据里读不到内容、AI 分析看不见、数字员工
 * 也答不了「客户发了语音」这种再常见不过的情形。解出 WAV 之后：先能听，再能转写。
 *
 * 参考实现：jiangtejie/wx-decode（MIT）的 VoiceInfo 取数与 silk-wasm 用法，按我们的缓存/协议方式重写。
 */

/** PCM 采样率（微信语音固定 24kHz 单声道） */
const SILK_SAMPLE_RATE = 24000

export interface VoiceWavResult {
  ok: boolean
  error?: string
  /** ct-media:// URL（可直接给 <audio> 播放） */
  url?: string
  durationMs?: number
}

/** 44 字节 WAV 头 + PCM（实现已收进 audio.ts，这里转出保持既有引用） */
import { wavDurationMs, wrapPcmToWav } from './audio'
export { wavDurationMs, wrapPcmToWav }

/** 语音缓存上限（默认 256MB / 500 个文件）：不设上限的话，聊得越久磁盘越满 */
const DEFAULT_VOICE_CACHE_MB = 256
const DEFAULT_VOICE_CACHE_FILES = 500

/**
 * 语音缓存淘汰：超上限按最旧删除。
 * 删除失败（文件正被 <audio> 占用）忽略，下轮再试。
 */
export function pruneVoiceCache(wxid: string): { removed: number; freedBytes: number } {
  const maxBytes =
    Math.max(0, getConfigNumber('wechat.voiceCacheMaxMB', DEFAULT_VOICE_CACHE_MB)) * 1024 * 1024
  const maxFiles = Math.max(
    1,
    getConfigNumber('wechat.voiceCacheMaxFiles', DEFAULT_VOICE_CACHE_FILES)
  )
  let removed = 0
  let freedBytes = 0
  try {
    const dir = join(getMediaCacheDir(wxid), 'voices')
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.wav'))
      .map((e) => {
        const full = join(dir, e.name)
        const st = statSync(full)
        return { full, size: st.size, mtimeMs: st.mtimeMs }
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs)
    let total = entries.reduce((sum, e) => sum + e.size, 0)
    let count = entries.length
    for (const e of entries) {
      if (total <= maxBytes && count <= maxFiles) break
      try {
        unlinkSync(e.full)
        total -= e.size
        count -= 1
        removed += 1
        freedBytes += e.size
      } catch {
        /* 被占用：下轮再试 */
      }
    }
  } catch {
    /* 目录不存在等：无需处理 */
  }
  return { removed, freedBytes }
}

/** 定位账号的 media_*.db（语音数据在这些库里） */
function findMediaDbs(wxid: string): string[] {
  const profile = keyRepo.getKey(wxid)
  const root = profile?.dbPath?.trim()
  if (!root) return []
  const paths = locateWeChatDbs(root, wxid)
  if (!paths.dbStoragePath) return []
  const dir = join(paths.dbStoragePath, 'message')
  try {
    return readdirSync(dir)
      .filter((n) => /^media_\d+\.db$/i.test(n))
      .map((n) => join(dir, n))
  } catch {
    return []
  }
}

interface VoiceRow {
  voice_data: unknown
  create_time?: number | null
}

/**
 * 从 VoiceInfo 里取 SILK 数据：svr_id 精确匹配 → svr_id 容差匹配 → local_id + create_time。
 *
 * 为什么要「容差」这一档：`VoiceInfo.svr_id` 是 **INTEGER**，而它是 19 位的 64 位整数，
 * 经 better-sqlite3 读进 JS 会按 double 舍入（实测 `…795967` 变成 `…796000`）。
 * 渲染端拿到的 `message.serverId` 正是这种被舍入过的值，于是「精确文本匹配」必然落空、
 * `svr_id = ?` 也不行 —— 只有带容差的数值比较能命中（相邻 svr_id 相差上亿，4096 的窗口很安全）。
 */
function findVoiceSilk(
  wxid: string,
  hexKey: string,
  opts: { serverId?: string; localId?: number; createTime?: number }
): Buffer | null {
  const serverId = (opts.serverId ?? '').trim()
  for (const file of findMediaDbs(wxid)) {
    const opened = openWxDbFile(file, hexKey)
    const db = opened.db
    if (!db) continue
    try {
      const hasVoiceInfo = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='VoiceInfo'")
        .get()
      if (!hasVoiceInfo) continue
      let row: VoiceRow | undefined
      if (serverId) {
        // 1) 精确（调用方给的是从 SQL 取出的原文）
        row = db
          .prepare(
            'SELECT voice_data, create_time FROM VoiceInfo WHERE CAST(svr_id AS TEXT) = ? LIMIT 1'
          )
          .get(serverId) as VoiceRow | undefined
        // 2) 容差（调用方给的是经 JS number 舍入过的 64 位 id）
        if (!row && /^\d+$/.test(serverId)) {
          row = db
            .prepare(
              'SELECT voice_data, create_time FROM VoiceInfo WHERE ABS(svr_id - CAST(? AS INTEGER)) <= 4096 LIMIT 1'
            )
            .get(serverId) as VoiceRow | undefined
        }
      }
      if (!row && typeof opts.localId === 'number') {
        // create_time 的单位随库版本变化（秒 / 毫秒），按量级选窗口，避免拿错同 local_id 的另一条语音
        const window =
          typeof opts.createTime === 'number' && opts.createTime > 0
            ? opts.createTime > 1e11
              ? 60000
              : 60
            : 0
        row = db
          .prepare(
            'SELECT voice_data, create_time FROM VoiceInfo WHERE local_id = ?' +
              (window ? ' AND ABS(create_time - ?) < ' + window : '') +
              ' LIMIT 1'
          )
          .get(...(window ? [opts.localId, opts.createTime as number] : [opts.localId])) as
          VoiceRow | undefined
      }
      if (row?.voice_data) {
        const raw = row.voice_data
        if (Buffer.isBuffer(raw)) return raw
        if (raw instanceof Uint8Array) return Buffer.from(raw)
      }
    } catch (e) {
      voiceLog.debug(`读取语音失败 ${file}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      try {
        db.close()
      } catch {
        /* ignore */
      }
    }
  }
  return null
}

/** SILK → WAV（用 silk-wasm；未安装时返回可行动提示） */
export async function decodeSilkToWav(
  silk: Buffer
): Promise<{ ok: true; wav: Buffer } | { ok: false; error: string }> {
  type SilkModule = { decode?: (data: Buffer, sampleRate: number) => Promise<{ data: unknown }> }
  let silkWasm: SilkModule
  try {
    // 可选依赖：没装时功能降级（内网/裁剪安装都可能遇到）
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- 可选依赖必须运行时加载，装不上要能降级
    silkWasm = require('silk-wasm') as SilkModule
  } catch {
    return { ok: false, error: '未安装 silk-wasm（npm i silk-wasm），无法解码语音' }
  }
  try {
    const out = await silkWasm.decode?.(silk, SILK_SAMPLE_RATE)
    if (!out?.data) return { ok: false, error: '语音解码无输出（数据可能不是 SILK）' }
    const pcm = Buffer.isBuffer(out.data) ? out.data : Buffer.from(out.data as Uint8Array)
    return { ok: true, wav: wrapPcmToWav(pcm) }
  } catch (e) {
    return { ok: false, error: `语音解码失败: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/**
 * 取某条语音消息的 WAV：命中缓存直接返回 URL，否则从 VoiceInfo 取 SILK → 解码 → 落缓存。
 * 产物走 ct-media 协议，渲染端 <audio> 可直接播。
 */
export async function getVoiceWav(opts: {
  wxid: string
  hexKey: string
  serverId?: string
  localId?: number
  createTime?: number
}): Promise<VoiceWavResult> {
  const wxid = (opts.wxid ?? '').trim()
  if (!wxid) return { ok: false, error: '缺少账号' }
  const cacheDir = join(getMediaCacheDir(wxid), 'voices')
  const cacheName = `${opts.serverId || opts.localId || Date.now()}.wav`
  const cacheFile = join(cacheDir, cacheName)
  try {
    mkdirSync(cacheDir, { recursive: true })
  } catch {
    return { ok: false, error: '无法创建语音缓存目录' }
  }
  if (existsSync(cacheFile)) {
    return { ok: true, url: toVoiceMediaUrl(wxid, cacheName) }
  }

  const silk = findVoiceSilk(wxid, opts.hexKey, opts)
  if (!silk) {
    return { ok: false, error: '在 VoiceInfo 里没找到这条语音（可能已被微信清理或还没落库）' }
  }
  const decoded = await decodeSilkToWav(silk)
  if (!decoded.ok) return { ok: false, error: decoded.error }
  try {
    writeFileSync(cacheFile, decoded.wav)
    pruneVoiceCache(wxid)
  } catch (e) {
    return { ok: false, error: `写入语音缓存失败: ${e instanceof Error ? e.message : String(e)}` }
  }
  return { ok: true, url: toVoiceMediaUrl(wxid, cacheName), durationMs: wavDurationMs(decoded.wav) }
}

export interface VoiceSilkResult {
  ok: boolean
  /** 微信原生的 SILK 数据（腾讯云 ASR 直接支持该格式，免解码/免重采样） */
  silk?: Buffer
  /** 该语音在缓存里的文件名（`<serverId|localId>.wav`）：转写文本按它改名成 .txt 存同一目录 */
  cacheName?: string
  error?: string
}

/**
 * 取某条语音的 SILK 原始数据（不做解码）。
 * 云 ASR 走这条路：SILK 是微信语音的原生格式，官方文档明确支持，省掉一次有损转换。
 */
export function getVoiceSilk(opts: {
  wxid: string
  hexKey: string
  serverId?: string
  localId?: number
  createTime?: number
}): VoiceSilkResult {
  const wxid = (opts.wxid ?? '').trim()
  if (!wxid) return { ok: false, error: '缺少账号' }
  const silk = findVoiceSilk(wxid, opts.hexKey, opts)
  if (!silk)
    return { ok: false, error: '在 VoiceInfo 里没找到这条语音（可能已被微信清理或还没落库）' }
  return { ok: true, silk, cacheName: `${opts.serverId || opts.localId || Date.now()}.wav` }
}
