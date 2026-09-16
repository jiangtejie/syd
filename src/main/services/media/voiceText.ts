/**
 * 语音消息（文本侧 + 上报规划）的纯逻辑，**零依赖**（不 import 任何本地模块）。
 *
 * 为什么必须零依赖：scripts/report-voice-selftest.mjs 用 `node --experimental-strip-types` 直接跑，
 * node 的 ESM 解析器不认「无扩展名的相对导入」（仓库 src 里全是无扩展名写法，tsc 也只接受那种），
 * 所以能被自检 import 的模块必须自包含 —— 这也是它把命名/组装/挑选/归档四类规则收在一起的原因。
 *
 * 这套规则同时被四处用到：读取层合流转写（media/voiceTranscript）、上报落库与转写规划
 * （report/chatSyncRunner）、音频归档（report/mediaArchive）、界面展示（MessagePanel）。
 * 只要有一处口径写歪，表现都是「库里还是 [语音]」，肉眼分不出是哪一处错。
 */

/** 语音消息的本地类型（微信 34；上报层的 msg_type 命名里 40 也叫「语音消息」） */
export const VOICE_LOCAL_TYPES: readonly number[] = [34]

/** 每轮最多转写几条语音（0=关闭）。任务参数缺省时按它走，历史任务不用重配就有能力 */
export const DEFAULT_ASR_PER_RUN = 5

/** 腾讯云一句话识别限制音频 ≤60s：超长的直接跳过，省一次注定失败的请求与配额 */
export const MAX_ASR_DURATION_MS = 60_000

/** 一条语音在缓存里的文件名（与 voice.ts 的 `<serverId | localId>.wav` 规则一致；都没有时返回空串） */
export function voiceCacheName(serverId?: string, localId?: number): string {
  const sid = (serverId ?? '').trim()
  if (sid) return `${sid}.wav`
  return typeof localId === 'number' && Number.isFinite(localId) && localId > 0
    ? `${localId}.wav`
    : ''
}

/** 转写产物名：与 WAV 同名、改扩展名（同名便于按 serverId 直接查） */
export function transcriptNameFor(wavName: string): string {
  return wavName.replace(/\.wav$/i, '') + '.txt'
}

/**
 * 解析语音消息的可读内容：`[语音] 8″ 你好` → { seconds: 8, text: '你好' }。
 * 非 `[语音]` 开头（含空串）一律返回 { seconds: null, text: '' }，调用方据此判断「有没有转写文本」。
 */
export function parseVoiceParsedContent(parsedContent: string): {
  seconds: number | null
  text: string
} {
  const m = /^\[语音\](?:\s*(\d+)″)?\s*([\s\S]*)$/.exec((parsedContent ?? '').trim())
  if (!m) return { seconds: null, text: '' }
  const n = m[1] ? Number.parseInt(m[1], 10) : 0
  return { seconds: n > 0 ? n : null, text: (m[2] ?? '').trim() }
}

/**
 * 组装语音消息的可读内容：`[语音] 8″ 文本`；缺文本就只剩 `[语音] 8″`，两段都缺就是 `[语音]`。
 * 全文唯一口径：读取层合流、上报落库、界面展示都用它，避免三处各写一遍正则。
 */
export function composeVoiceContent(seconds: number | null | undefined, text: string): string {
  const body = (text ?? '').trim()
  const sec = typeof seconds === 'number' && seconds > 0 ? ` ${Math.round(seconds)}″` : ''
  return body ? `[语音]${sec} ${body}` : `[语音]${sec}`
}

export interface VoicePlanRow {
  sessionWxid: string
  localId: number
  serverId: string
  createTime: number
  /** 消息 XML 里的语音时长（毫秒）；解析不到为 null */
  durationMs: number | null
}

/**
 * 微信消息 → 语音任务行（非语音返回 null）。
 * 要求 serverId / localId 至少有一个：转写与归档都要靠它去 VoiceInfo 里定位 SILK。
 */
export function voiceRowOf(
  sessionWxid: string,
  m: {
    localType: number
    localId?: number
    serverId?: string
    createTime?: number
    voiceDuration?: number
  }
): VoicePlanRow | null {
  if (m.localType !== 34) return null
  const localId = Number(m.localId)
  const serverId = (m.serverId ?? '').trim()
  if (!serverId && !(Number.isInteger(localId) && localId > 0)) return null
  const dur = typeof m.voiceDuration === 'number' && m.voiceDuration > 0 ? m.voiceDuration : null
  return {
    sessionWxid,
    localId: Number.isInteger(localId) && localId > 0 ? localId : 0,
    serverId,
    createTime: Number(m.createTime) || 0,
    durationMs: dur
  }
}

/**
 * 落库时语音专有两列的取值：转写文本 + 时长（毫秒）。
 * 非语音返回全 null —— 下游据此可以直接 `WHERE voice_text IS NOT NULL` 筛「有内容的语音」。
 */
export function voiceColumnsOf(m: {
  localType: number
  parsedContent?: string
  voiceDuration?: number
}): { voiceText: string | null; voiceDurationMs: number | null } {
  if (m.localType !== 34) return { voiceText: null, voiceDurationMs: null }
  const parsed = parseVoiceParsedContent(m.parsedContent ?? '')
  const byXml =
    typeof m.voiceDuration === 'number' && m.voiceDuration > 0 ? Math.round(m.voiceDuration) : null
  return {
    voiceText: parsed.text || null,
    voiceDurationMs: byXml ?? (parsed.seconds ? parsed.seconds * 1000 : null)
  }
}

export interface VoiceAsrTask extends VoicePlanRow {
  /** 缓存/转写产物基名（`<serverId | localId>.wav`） */
  cacheName: string
  /** 消息里的时长（秒），用于拼 `[语音] N″`；解析不到为 null */
  seconds: number | null
}

/**
 * 挑出本轮要转写的语音。
 *
 * 规则（每条都由自检钉住）：
 * - **预算 = 尝试次数**：包含失败的，避免一条坏语音每轮吃掉名额却永远不成功；
 * - **新→旧**：客服场景里最近发的语音最该先有文本；
 * - 跳过已转写（缓存里有 .txt）、跳过超长（> maxDurationMs）、跳过内存里连续失败的；
 * - 按缓存名去重（同一条语音可能散在多个分片库里）。
 */
export function pickVoiceAsrTasks(
  rows: VoicePlanRow[],
  opts: {
    /** 是否已有转写文本（调用方传 readVoiceTranscript/hasVoiceTranscript 的封装） */
    hasTranscript: (cacheName: string) => boolean
    /** 本轮最多尝试几条 */
    budget: number
    /** 额外的跳过判定（连续失败记忆） */
    skip?: (cacheName: string) => boolean
    maxDurationMs?: number
  }
): VoiceAsrTask[] {
  const budget = Math.max(0, Math.floor(opts.budget))
  if (budget <= 0) return []
  const maxDur = opts.maxDurationMs ?? MAX_ASR_DURATION_MS
  const seen = new Set<string>()
  const out: VoiceAsrTask[] = []
  const sorted = [...rows].sort((a, b) => b.createTime - a.createTime)
  for (const r of sorted) {
    if (out.length >= budget) break
    const cacheName = voiceCacheName(r.serverId, r.localId)
    if (!cacheName || seen.has(cacheName)) continue
    seen.add(cacheName)
    if (r.durationMs !== null && r.durationMs > maxDur) continue
    if (opts.hasTranscript(cacheName)) continue
    if (opts.skip?.(cacheName)) continue
    out.push({
      ...r,
      cacheName,
      seconds: r.durationMs ? Math.max(1, Math.round(r.durationMs / 1000)) : null
    })
  }
  return out
}

/**
 * 语音归档文件名：`<serverId | localId>_voice.wav`。
 * 与图片的 `<md5>_orig` / 视频的 `<md5>_video` 同一手法：扁平归档目录靠 id 防冲突。
 */
export function voiceArchiveName(serverId?: string, localId?: number): string | null {
  const sid = (serverId ?? '').trim()
  if (sid) return `${sid}_voice.wav`
  return typeof localId === 'number' && Number.isInteger(localId) && localId > 0
    ? `${localId}_voice.wav`
    : null
}
