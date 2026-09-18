import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import { getConfig, getConfigNumber, setConfig } from '../../db/repos/config'
import { getVoiceCacheDir } from '../paths'
import { getDecryptedKey, hasAnyKey } from '../keyStoreService'
import { getVoiceSilk } from './voice'
import { readVoiceTranscript, transcriptNameFor } from './voiceTranscript'
import {
  buildSentenceRecognitionBody,
  parseSentenceRecognitionResponse,
  tc3Authorization
} from './asrTencentPure'
import { createLogger } from '../logging'

const log = createLogger('asr-tencent')

/**
 * 语音转写：腾讯云「一句话识别」（SentenceRecognition，2019-06-14）。
 *
 * 为什么选它：微信语音就是 SILK，而该接口官方支持 `VoiceFormat=silk`（≤60s、base64 后 ≤3MB）——
 * 可以直接把 VoiceInfo 里的原始数据发上去，**不需要解码成 WAV、也不需要重采样**，链路最短、信息无损。
 *
 * 安全：SecretKey 用 Electron `safeStorage` 加密后存 `app_config`（`enc:<base64>`），
 * 渲染端只显示「已保存」，明文只在主进程内存里；读取失败（换机器/换系统账号）按「未配置」处理并提示重填。
 *
 * 产物：识别文本写到语音缓存目录下与 WAV 同名的 `.txt`，由 `voiceTranscript.decorateVoiceTranscripts`
 * 并进消息内容 —— 界面、议题分析、数字员工就都能看到这句语音在说什么。
 */

/** SecretKey 在 app_config 里的密文前缀（明文值不带前缀，便于识别历史遗留） */
const ENC_PREFIX = 'enc:'

export interface AsrTencentConfig {
  secretId: string
  secretKey: string
  region: string
  engine: string
  voiceFormat: string
  timeoutMs: number
}

/** 保存 SecretKey：渲染端只提交新值，主进程加密后落 `app_config`（`enc:<base64>`） */
export function saveAsrSecretKey(plain: string): { ok: boolean; error?: string } {
  const value = (plain ?? '').trim()
  if (!value) return { ok: false, error: 'SecretKey 不能为空' }
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: '系统加密不可用，无法安全保存 SecretKey' }
    }
    const encrypted = safeStorage.encryptString(value).toString('base64')
    setConfig('asr.tencent.secretKey', ENC_PREFIX + encrypted)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 读 SecretKey（解密失败返回空串，调用方据此提示重填） */
function readSecretKey(): string {
  const raw = getConfig('asr.tencent.secretKey') ?? ''
  if (!raw) return ''
  if (!raw.startsWith(ENC_PREFIX)) return raw.trim() // 历史明文值：兼容读取
  try {
    return safeStorage.decryptString(Buffer.from(raw.slice(ENC_PREFIX.length), 'base64')).trim()
  } catch {
    return ''
  }
}

export function asrTencentConfig(): AsrTencentConfig {
  return {
    secretId: (getConfig('asr.tencent.secretId') ?? '').trim(),
    secretKey: readSecretKey(),
    region: (getConfig('asr.tencent.region') ?? 'ap-guangzhou').trim(),
    engine: (getConfig('asr.tencent.engine') ?? '16k_zh').trim(),
    voiceFormat: (getConfig('asr.tencent.voiceFormat') ?? 'silk').trim(),
    timeoutMs: Math.max(5000, getConfigNumber('asr.tencent.timeoutMs', 20_000))
  }
}

export interface AsrTencentStatus {
  available: boolean
  secretId: string
  /** SecretKey 是否已保存（不回传明文） */
  hasSecretKey: boolean
  region: string
  engine: string
  voiceFormat: string
  reason?: string
}

export function asrTencentStatus(): AsrTencentStatus {
  const cfg = asrTencentConfig()
  const base: AsrTencentStatus = {
    available: false,
    secretId: cfg.secretId,
    hasSecretKey: !!cfg.secretKey,
    region: cfg.region,
    engine: cfg.engine,
    voiceFormat: cfg.voiceFormat
  }
  if (!cfg.secretId) return { ...base, reason: '未配置 SecretId（腾讯云 → 访问管理 → API 密钥）' }
  if (!cfg.secretKey) {
    return {
      ...base,
      reason: 'SecretKey 未保存或无法解密（换机器/换系统账号后需要重填）'
    }
  }
  return { ...base, available: true }
}

const HOST = 'asr.tencentcloudapi.com'
const SERVICE = 'asr'
const ACTION = 'SentenceRecognition'
const VERSION = '2019-06-14'
/** 官方限制：base64 后不超过 3MB */
const MAX_BASE64_BYTES = 3 * 1024 * 1024

export interface TranscribeResult {
  ok: boolean
  text?: string
  cached?: boolean
  audioDurationMs?: number
  requestId?: string
  error?: string
}

/**
 * 转写一条语音：命中缓存直接返回；否则取 SILK → base64 → 签名 → 调云接口 → 写同名 .txt。
 * 失败只返回原因，不抛异常（界面按「未转写」展示即可）。
 */
export async function transcribeVoice(opts: {
  wxid: string
  serverId?: string
  localId?: number
  createTime?: number
  force?: boolean
}): Promise<TranscribeResult> {
  const wxid = (opts.wxid ?? '').trim()
  if (!wxid) return { ok: false, error: '缺少账号' }
  const status = asrTencentStatus()
  if (!status.available) return { ok: false, error: status.reason }

  const hexKey = getDecryptedKey(wxid) || ''
  if (!hexKey && !hasAnyKey(wxid)) {
    return { ok: false, error: '未配置数据库密钥，请先在设置里导入' }
  }

  const silk = getVoiceSilk({
    wxid,
    hexKey,
    serverId: opts.serverId,
    localId: opts.localId,
    createTime: opts.createTime
  })
  if (!silk.ok || !silk.silk || !silk.cacheName)
    return { ok: false, error: silk.error ?? '取语音失败' }
  const txtName = transcriptNameFor(silk.cacheName)
  const txtPath = join(getVoiceCacheDir(wxid), txtName)
  if (!opts.force) {
    const cached = readVoiceTranscript(wxid, silk.cacheName)
    if (cached) return { ok: true, text: cached, cached: true }
  }

  const data = silk.silk.toString('base64').replace(/[\r\n]/g, '')
  if (data.length > MAX_BASE64_BYTES) {
    return {
      ok: false,
      error: `语音过大（base64 后 ${Math.round(data.length / 1024)}KB），超过官方 3MB 限制`
    }
  }
  const cfg = asrTencentConfig()
  const payload = buildSentenceRecognitionBody({
    data,
    dataLen: silk.silk.length,
    engine: cfg.engine,
    voiceFormat: cfg.voiceFormat
  })
  const timestamp = Math.floor(Date.now() / 1000)
  const authorization = tc3Authorization({
    secretId: cfg.secretId,
    secretKey: cfg.secretKey,
    service: SERVICE,
    host: HOST,
    action: ACTION,
    version: VERSION,
    region: cfg.region,
    payload,
    timestamp
  })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs)
  let raw = ''
  try {
    const res = await fetch(`https://${HOST}/`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json; charset=utf-8',
        Host: HOST,
        'X-TC-Action': ACTION,
        'X-TC-Timestamp': String(timestamp),
        'X-TC-Version': VERSION,
        'X-TC-Region': cfg.region
      },
      body: payload,
      signal: controller.signal
    })
    raw = await res.text()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      ok: false,
      error: controller.signal.aborted ? `请求超时（${cfg.timeoutMs}ms）` : `请求失败: ${msg}`
    }
  } finally {
    clearTimeout(timer)
  }

  const parsed = parseSentenceRecognitionResponse(raw)
  if (!parsed.ok) {
    log.warn(`转写失败 ${silk.cacheName}: ${parsed.error}`)
    return { ok: false, error: parsed.error, requestId: parsed.requestId }
  }
  const text = (parsed.text ?? '').trim()
  if (!text) return { ok: false, error: '没听清（识别结果为空）', requestId: parsed.requestId }
  try {
    writeFileSync(txtPath, text, 'utf8')
  } catch (e) {
    log.warn(`转写文本写入失败: ${e instanceof Error ? e.message : String(e)}`)
  }
  log.info(
    `语音转写完成 ${silk.cacheName}（${text.length} 字，${parsed.audioDurationMs ?? '?'}ms）`
  )
  return { ok: true, text, audioDurationMs: parsed.audioDurationMs, requestId: parsed.requestId }
}

/** 是否已存在该语音的转写文本（界面用来决定是否显示「转写」按钮） */
export function hasVoiceTranscript(wxid: string, cacheName: string): boolean {
  try {
    return existsSync(join(getVoiceCacheDir(wxid), transcriptNameFor(cacheName)))
  } catch {
    return false
  }
}
