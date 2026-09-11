import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getConfig, getConfigNumber } from '../../db/repos/config'
import { getCacheSubPath, getVoiceCacheDir } from '../paths'
import { createLogger } from '../logging'
import { ASR_SAMPLE_RATE, resamplePcm16, wrapPcmToWav } from './audio'
import { buildWhisperArgs, cleanTranscript, transcriptNameFor } from './asrPure'
import { getVoiceWav } from './voice'
import { parseMediaPath } from './mediaProtocol'
import { getMediaRootDir } from '../paths'

const asrLog = createLogger('asr')

/**
 * 本地语音转写（whisper.cpp，**外部可执行文件 + 本地模型**，全部离线）。
 *
 * 为什么不内置：whisper 模型动辄几百 MB，且 whisper.cpp 是编译产物 —— 内置会让安装包大一圈，
 * 还要跟着上游更新。所以走「用户给一个 whisper 可执行文件 + 一个模型文件，我们负责把
 * 微信 24kHz SILK→WAV 的产物重采样成 16kHz、喂进去、清理输出、按消息缓存结果」这条路线，
 * 和 ffmpeg（HEVC 转码）是同一套思路。没配就不转写，界面明确提示去哪里配。
 *
 * 稳健性约定：
 * - 单进程串行（一个 whisper 进程同时只跑一个，避免把闲置机器的 CPU 打满）；
 * - 带超时（默认 120s）与 maxBuffer，失败只影响这一条语音；
 * - 转写结果落 <媒体缓存>/<wxid>/voices/<id>.txt 旁挂缓存：WAV 会被容量策略淘汰，
 *   转写文本很小、保留着更值钱（淘汰只清 .wav，见 voice.ts）；
 * - 全流程不联网。
 */

export interface AsrConfig {
  whisperPath: string
  modelPath: string
  language: string
  threads: number
  timeoutMs: number
}

export function asrConfig(): AsrConfig {
  return {
    whisperPath: (getConfig('asr.whisperPath') ?? '').trim(),
    modelPath: (getConfig('asr.modelPath') ?? '').trim(),
    language: (getConfig('asr.language') ?? 'zh').trim(),
    threads: Math.max(0, getConfigNumber('asr.threads', 0)),
    timeoutMs: Math.max(10_000, getConfigNumber('asr.timeoutMs', 120_000))
  }
}

export interface AsrStatus {
  available: boolean
  whisperPath: string
  modelPath: string
  language: string
  reason?: string
}

/** 是否具备转写条件（配置齐全 + 文件存在） */
export function asrStatus(): AsrStatus {
  const cfg = asrConfig()
  const base: AsrStatus = {
    available: false,
    whisperPath: cfg.whisperPath,
    modelPath: cfg.modelPath,
    language: cfg.language
  }
  if (!cfg.whisperPath) {
    return { ...base, reason: '未配置 whisper 可执行文件（设置 → 媒体解密 → 语音转写）' }
  }
  if (!existsSync(cfg.whisperPath)) {
    return { ...base, reason: `whisper 可执行文件不存在: ${cfg.whisperPath}` }
  }
  if (!cfg.modelPath) {
    return { ...base, reason: '未配置 whisper 模型文件（ggml-*.bin）' }
  }
  if (!existsSync(cfg.modelPath)) {
    return { ...base, reason: `whisper 模型文件不存在: ${cfg.modelPath}` }
  }
  return { ...base, available: true }
}

/** 串行队列：whisper 很吃 CPU，闲置机器上也不该同时跑多个 */
let queue: Promise<unknown> = Promise.resolve()
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.catch(() => undefined)
  return run
}

function runWhisper(cfg: AsrConfig, wavPath: string, outBase: string): Promise<void> {
  const args = buildWhisperArgs({
    wavPath,
    modelPath: cfg.modelPath,
    outBase,
    language: cfg.language || undefined,
    threads: cfg.threads
  })
  return new Promise<void>((resolve, reject) => {
    execFile(
      cfg.whisperPath,
      args,
      { timeout: cfg.timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, _stdout, stderr) => {
        if (err) {
          const msg = err.message || String(err)
          reject(
            new Error(
              /ENOENT/.test(msg) ? 'whisper 可执行文件无法启动（路径不对或不是可执行文件）' : msg
            )
          )
          return
        }
        // 部分构建把提示信息写 stderr，不作为失败
        if (stderr && /error|failed/i.test(stderr) && !existsSync(outBase + '.txt')) {
          reject(new Error(stderr.trim().slice(0, 300)))
          return
        }
        resolve()
      }
    )
  })
}

/** WAV 绝对路径 → 该语音的转写缓存文件路径（<媒体缓存>/<wxid>/voices/<id>.txt） */
function transcriptPathForWav(wavAbs: string): string {
  return join(dirname(wavAbs), transcriptNameFor(wavAbs.split(/[\\/]/).pop() ?? 'voice.wav'))
}

/** 从 ct-media URL 反解 WAV 绝对路径 */
function wavAbsFromUrl(url: string): string | null {
  try {
    const { hit } = parseMediaPath(new URL(url).pathname)
    if (!hit || hit.kind !== 'voice') return null
    return join(getMediaRootDir(), hit.wxid, ...hit.rel)
  } catch {
    return null
  }
}

/** 已缓存的转写文本（不触发转写）；供查询层/界面按需读取 */
export function readVoiceTranscript(wxid: string, voiceName: string): string | null {
  try {
    const p = join(getVoiceCacheDir(wxid), transcriptNameFor(voiceName))
    if (!existsSync(p)) return null
    const text = readFileSync(p, 'utf8').trim()
    return text || null
  } catch {
    return null
  }
}

export interface TranscriptResult {
  ok: boolean
  text?: string
  error?: string
  /** 是否命中缓存（没真的跑 whisper） */
  cached?: boolean
  /** 语音本身就有多长（毫秒） */
  durationMs?: number
}

/**
 * 转写一条语音：命中缓存直接返回；否则确保 WAV 存在 → 重采样 16kHz → 跑 whisper → 清理并缓存文本。
 * 失败只返回原因，不抛异常（界面按「未转写」展示即可）。
 */
export async function transcribeVoice(opts: {
  wxid: string
  serverId?: string
  localId?: number
  createTime?: number
  /** 忽略缓存强制重转 */
  force?: boolean
}): Promise<TranscriptResult> {
  const wxid = (opts.wxid ?? '').trim()
  if (!wxid) return { ok: false, error: '缺少账号' }
  const status = asrStatus()
  if (!status.available) return { ok: false, error: status.reason }

  const resolved = await resolveVoiceWav(wxid, opts)
  if (!resolved.ok) return { ok: false, error: resolved.error }
  const wavAbs = resolved.wavAbs
  const wavName = wavAbs.split(/[\\/]/).pop() ?? 'voice.wav'
  const txtPath = transcriptPathForWav(wavAbs)
  if (!opts.force) {
    const cached = readVoiceTranscript(wxid, wavName)
    if (cached) return { ok: true, text: cached, cached: true }
  }

  const cfg = asrConfig()
  return enqueue(async () => {
    const tmpDir = getCacheSubPath('tmp')
    const stamp = `asr-${process.pid}-${Date.now()}`
    const tmpWav = join(tmpDir, `${stamp}.wav`)
    const outBase = join(tmpDir, stamp)
    try {
      const raw = readFileSync(wavAbs)
      if (raw.length <= 44) return { ok: false, error: '语音文件为空' }
      // 微信语音是 24kHz；whisper.cpp 只认 16kHz，必须重采样（见 audio.ts）
      const pcm16 = resamplePcm16(raw.subarray(44), 24000, ASR_SAMPLE_RATE)
      writeFileSync(tmpWav, wrapPcmToWav(pcm16, ASR_SAMPLE_RATE))
      await runWhisper(cfg, tmpWav, outBase)
      const outTxt = outBase + '.txt'
      if (!existsSync(outTxt))
        return { ok: false, error: 'whisper 没有产出文本（模型或参数可能不对）' }
      const text = cleanTranscript(readFileSync(outTxt, 'utf8'))
      if (!text) return { ok: false, error: '没听清（whisper 输出为空或全是噪声标记）' }
      try {
        mkdirSync(dirname(txtPath), { recursive: true })
        writeFileSync(txtPath, text, 'utf8')
      } catch (e) {
        asrLog.warn(`转写缓存写入失败: ${e instanceof Error ? e.message : String(e)}`)
      }
      asrLog.info(`语音转写完成 ${wavName}（${text.length} 字）`)
      return { ok: true, text }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      asrLog.warn(`语音转写失败 ${wavName}: ${msg}`)
      return { ok: false, error: `转写失败: ${msg}` }
    } finally {
      for (const p of [
        tmpWav,
        outBase + '.txt',
        outBase + '.srt',
        outBase + '.vtt',
        outBase + '.json'
      ]) {
        try {
          if (existsSync(p)) rmSync(p, { force: true })
        } catch {
          /* 临时文件清理失败不影响结果 */
        }
      }
    }
  })
}

/** 确保语音 WAV 存在并返回绝对路径（hexKey 由主进程从 keyStore 取） */
async function resolveVoiceWav(
  wxid: string,
  opts: { serverId?: string; localId?: number; createTime?: number }
): Promise<{ ok: true; wavAbs: string } | { ok: false; error: string }> {
  const { getDecryptedKey } = await import('../keyStoreService')
  const hexKey = getDecryptedKey(wxid)
  if (!hexKey) return { ok: false, error: '未配置数据库密钥' }
  const r = await getVoiceWav({ wxid, hexKey, ...opts })
  if (!r.ok || !r.url) return { ok: false, error: r.error ?? '语音解码失败' }
  const abs = wavAbsFromUrl(r.url)
  if (!abs || !existsSync(abs)) return { ok: false, error: '语音文件不存在' }
  return { ok: true, wavAbs: abs }
}

/**
 * 给一批消息补上「已转写的语音内容」：只处理 type 34 且侧存存在的情况。
 * 结果写进 parsedContent（形如 `[语音] 8″ 转写文本`），这样界面、议题分析、数字员工
 * 读到的是同一份文本 —— 不需要各自再去读文件。
 */
export function decorateVoiceTranscripts<
  T extends { localType: number; serverId?: string; parsedContent: string; voiceDuration?: number }
>(messages: T[], wxid: string): T[] {
  if (!wxid || messages.length === 0) return messages
  for (const m of messages) {
    if (m.localType !== 34) continue
    const serverId = (m.serverId ?? '').trim()
    if (!serverId) continue
    if (m.parsedContent && !m.parsedContent.startsWith('[语音]')) continue
    const text = readVoiceTranscript(wxid, `${serverId}.wav`)
    if (!text) continue
    const seconds = m.voiceDuration ? Math.max(1, Math.round(m.voiceDuration / 1000)) : undefined
    m.parsedContent = `[语音]${seconds ? ` ${seconds}″` : ''} ${text}`
  }
  return messages
}
