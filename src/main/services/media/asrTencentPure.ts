import { createHash, createHmac } from 'node:crypto'

/**
 * 腾讯云 API 3.0 签名（TC3-HMAC-SHA256）与一句话识别请求体构造 —— **纯函数、零 IO、可离线自检**。
 *
 * 单独抽出来的原因：签名是整条云调用链里唯一「错了很难查」的部分（服务端只会回 AuthFailure），
 * 而它完全可以离线验证 —— 本仓的自检里存了一组由**腾讯官方 Node SDK 生成的黄金向量**，
 * 保证我们的实现与官方 SDK 同输入同输出（见 scripts/asr-tencent-selftest.mjs）。
 */

export interface Tc3Input {
  secretId: string
  secretKey: string
  /** 服务名，语音识别为 asr */
  service: string
  /** 请求 Host，语音识别为 asr.tencentcloudapi.com */
  host: string
  /** 接口名，一句话识别为 SentenceRecognition */
  action: string
  /** 接口版本，一句话识别为 2019-06-14 */
  version: string
  /** 地域（一句话识别可不传，传了也不生效） */
  region?: string
  /** 请求体 JSON 字符串 */
  payload: string
  /** UNIX 秒；调用方传入便于自检固定时间 */
  timestamp: number
  contentType?: string
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

/** UTC 日期（YYYY-MM-DD），必须用 UTC，否则跨时区会出现签名过期 */
export function utcDate(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().slice(0, 10)
}

/**
 * 规范请求串 + 待签串（分开导出便于自检逐段核对）。
 *
 * 注意 SignedHeaders 只取 `content-type;host`，**与腾讯官方 Node SDK 的 sign3 完全一致**
 * （官方文档的 curl 示例还签了 x-tc-action，两种都被接受；这里对齐 SDK 以求最大兼容性）——
 * 本仓自检里存的是官方 SDK 生成的黄金向量，同输入必须同输出。
 */
export function canonicalRequest(input: Tc3Input): { canonical: string; signedHeaders: string } {
  const contentType = input.contentType ?? 'application/json; charset=utf-8'
  const signedHeaders = 'content-type;host'
  const canonicalHeaders = 'content-type:' + contentType + '\n' + 'host:' + input.host + '\n'
  const canonical = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    sha256Hex(input.payload)
  ].join('\n')
  return { canonical, signedHeaders }
}

export function stringToSign(input: Tc3Input): string {
  const { canonical } = canonicalRequest(input)
  const date = utcDate(input.timestamp)
  return [
    'TC3-HMAC-SHA256',
    String(input.timestamp),
    `${date}/${input.service}/tc3_request`,
    sha256Hex(canonical)
  ].join('\n')
}

/** 计算 Authorization 头（含 Credential / SignedHeaders / Signature） */
export function tc3Authorization(input: Tc3Input): string {
  const date = utcDate(input.timestamp)
  const { signedHeaders } = canonicalRequest(input)
  const secretDate = hmac('TC3' + input.secretKey, date)
  const secretService = hmac(secretDate, input.service)
  const secretSigning = hmac(secretService, 'tc3_request')
  const signature = createHmac('sha256', secretSigning)
    .update(stringToSign(input), 'utf8')
    .digest('hex')
  return (
    'TC3-HMAC-SHA256 ' +
    `Credential=${input.secretId}/${date}/${input.service}/tc3_request, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`
  )
}

/** 签名相关的全部请求头（调用方直接合并进 fetch headers） */
export function tc3Headers(input: Tc3Input): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: tc3Authorization(input),
    'Content-Type': input.contentType ?? 'application/json; charset=utf-8',
    Host: input.host,
    'X-TC-Action': input.action,
    'X-TC-Timestamp': String(input.timestamp),
    'X-TC-Version': input.version
  }
  if (input.region) headers['X-TC-Region'] = input.region
  return headers
}

/* ── 一句话识别（SentenceRecognition）请求体 ── */

export interface SentenceRecognitionInput {
  /** base64（不含换行）音频数据 */
  data: string
  /** 未编码前的字节长度（官方要求必填） */
  dataLen: number
  /** 引擎模型，如 16k_zh / 16k_zh_dialect / 8k_zh */
  engine: string
  /** 音频格式：silk（微信语音原生）/ wav / mp3 ... */
  voiceFormat: string
  projectId?: number
  /** 词级时间戳：0 不显示 / 1 显示 / 2 含标点 */
  wordInfo?: number
  filterDirty?: number
  filterModal?: number
  filterPunc?: number
  /** 热词表 id（可选） */
  hotwordId?: string
  /** 自定义热词（可选） */
  customizationId?: string
}

/**
 * 构造请求体。注意：`Data` 必须是**不含换行的 base64**（官方文档明确要求），
 * `DataLen` 是 base64 **之前**的字节数，传错会被拒。
 */
export function buildSentenceRecognitionBody(input: SentenceRecognitionInput): string {
  const body: Record<string, unknown> = {
    ProjectId: input.projectId ?? 0,
    SubServiceType: 2,
    EngSerViceType: input.engine,
    SourceType: 1,
    VoiceFormat: input.voiceFormat,
    Data: input.data.replace(/[\r\n]/g, ''),
    DataLen: input.dataLen,
    WordInfo: input.wordInfo ?? 0
  }
  if (input.filterDirty !== undefined) body.FilterDirty = input.filterDirty
  if (input.filterModal !== undefined) body.FilterModal = input.filterModal
  if (input.filterPunc !== undefined) body.FilterPunc = input.filterPunc
  if (input.hotwordId) body.HotwordId = input.hotwordId
  if (input.customizationId) body.CustomizationId = input.customizationId
  return JSON.stringify(body)
}

/** 语音识别支持的上传格式（官方文档列举） */
export const ASR_VOICE_FORMATS = [
  'silk',
  'wav',
  'pcm',
  'ogg-opus',
  'speex',
  'mp3',
  'm4a',
  'aac',
  'amr'
] as const

/** 常用中文引擎（其余语言见官方文档；这里只列设置页会用到的） */
export const ASR_CHINESE_ENGINES = [
  '16k_zh',
  '16k_zh_dialect',
  '16k_zh-PY',
  '8k_zh',
  '16k_yue'
] as const

export interface SentenceRecognitionResult {
  ok: boolean
  text?: string
  audioDurationMs?: number
  requestId?: string
  errorCode?: string
  error?: string
}

/** 解析响应：成功取 Result，失败把错误码与信息带出来（便于界面直接展示） */
export function parseSentenceRecognitionResponse(raw: string): SentenceRecognitionResult {
  let json: { Response?: Record<string, unknown> } | null = null
  try {
    json = JSON.parse(raw) as { Response?: Record<string, unknown> }
  } catch {
    return { ok: false, error: `响应不是合法 JSON: ${raw.slice(0, 200)}` }
  }
  const resp = json?.Response
  if (!resp) return { ok: false, error: `响应缺少 Response 字段: ${raw.slice(0, 200)}` }
  const err = resp.Error as { Code?: string; Message?: string } | undefined
  if (err?.Code) {
    return {
      ok: false,
      errorCode: err.Code,
      error: `${err.Code}: ${err.Message ?? ''}`,
      requestId: typeof resp.RequestId === 'string' ? resp.RequestId : undefined
    }
  }
  const text = typeof resp.Result === 'string' ? resp.Result.trim() : ''
  return {
    ok: true,
    text,
    audioDurationMs: typeof resp.AudioDuration === 'number' ? resp.AudioDuration : undefined,
    requestId: typeof resp.RequestId === 'string' ? resp.RequestId : undefined
  }
}
