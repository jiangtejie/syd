import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

/** 44 字节 WAV 头 + PCM */
export function wrapPcmToWav(pcm: Buffer, sampleRate = SILK_SAMPLE_RATE, channels = 1): Buffer {
  const header = Buffer.alloc(44)
  const byteRate = sampleRate * channels * 2
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(channels * 2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
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

/** 从 VoiceInfo 里取 SILK 数据：优先按 svr_id，其次 local_id + create_time */
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
        row = db
          .prepare(
            'SELECT voice_data, create_time FROM VoiceInfo WHERE CAST(svr_id AS TEXT) = ? LIMIT 1'
          )
          .get(serverId) as VoiceRow | undefined
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
  } catch (e) {
    return { ok: false, error: `写入语音缓存失败: ${e instanceof Error ? e.message : String(e)}` }
  }
  return { ok: true, url: toVoiceMediaUrl(wxid, cacheName) }
}
