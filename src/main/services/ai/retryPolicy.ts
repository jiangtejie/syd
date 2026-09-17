/**
 * AI 通道的重试判定与退避（纯函数，零依赖，可离线自检）。
 *
 * 为什么需要：以前真实对话路径**零重试**（只有测试连通接口有超时），一次上游限流或网络抖动
 * 就是一批静默失败 —— 而群问题分析、数字员工值班都跑在无人值守的后台，没人看得见。
 *
 * 刻意不做的事：**不重试用户主动取消**。那是人的意图，重试只会让「点了停止又发出去」变成真。
 */

/** 总尝试次数（含首次） */
export const MAX_ATTEMPTS = 3
/** 单次等待上限：退避再长也不该让后台任务挂住 */
export const MAX_BACKOFF_MS = 30_000

/**
 * 可重试的 HTTP 状态：限流、网关/服务端临时故障、请求超时。
 * 4xx 里除了 408/429 一律不重试 —— 那是请求本身有问题（Key 错、模型名错、参数错），重试没意义。
 */
export function isRetryableStatus(status: number): boolean {
  if (status === 408 || status === 429) return true
  return status >= 500 && status <= 599
}

/** 错误分类（决定要不要重试、怎么报给用户） */
export type ErrorKind = 'aborted' | 'timeout' | 'network' | 'http' | 'other'

export function classifyError(err: unknown): ErrorKind {
  const name = (err as { name?: string } | null)?.name ?? ''
  const msg = err instanceof Error ? err.message : String(err ?? '')
  // 取消优先判：本仓库的中断原因是中文（「用户已取消」），不能只认 AbortError
  if (name === 'AbortError' || name === 'TimeoutError' || /取消|cancel|aborted by/i.test(msg)) {
    return 'aborted'
  }
  // 超时/挂死：含中文（「AI 请求超时」「流式响应空闲超过 45s，判定挂死」）
  if (/ETIMEDOUT|timed?\s?out|timeout|超时|挂死/i.test(msg)) return 'timeout'
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up/i.test(msg)) {
    return 'network'
  }
  if (/^LLM 调用失败 HTTP \d+/.test(msg)) return 'http'
  return 'other'
}

/**
 * 值不值得再试一次。
 * - 用户取消 / 超时中断：不重试（取消是意图；超时由调用方决定是否再来一轮）
 * - 网络类错误：重试
 * - HTTP 类：仅 408/429/5xx
 */
export function isRetryableError(err: unknown): boolean {
  const kind = classifyError(err)
  if (kind === 'aborted') return false
  if (kind === 'timeout' || kind === 'network') return true
  if (kind === 'http') {
    const m = /^LLM 调用失败 HTTP (\d+)/.exec(err instanceof Error ? err.message : '')
    return m ? isRetryableStatus(Number.parseInt(m[1], 10)) : false
  }
  return false
}

/**
 * 第 attempt 次失败后的等待时长（attempt 从 1 开始）。
 * 指数退避 + 抖动（避免多个后台任务同频重试），尊重上游的 Retry-After。
 */
export function backoffMs(attempt: number, retryAfterSec?: number, rand = Math.random): number {
  if (typeof retryAfterSec === 'number' && Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    return Math.min(MAX_BACKOFF_MS, Math.round(retryAfterSec * 1000))
  }
  const n = Math.max(1, Math.floor(attempt))
  const base = Math.min(MAX_BACKOFF_MS, 800 * Math.pow(3, n - 1))
  const jitter = 0.75 + rand() * 0.5 // ±25%
  return Math.max(100, Math.min(MAX_BACKOFF_MS, Math.round(base * jitter)))
}

/**
 * 构造 HTTP 错误：消息格式固定为 `LLM 调用失败 HTTP <status>: ...`（classifyError/isRetryableError
 * 靠它判类型），并把 Retry-After 挂在错误对象上供退避使用。
 */
export function aiHttpError(status: number, text: string, retryAfterSec?: number): Error {
  const err = new Error(`LLM 调用失败 HTTP ${status}: ${(text ?? '').slice(0, 200)}`)
  if (typeof retryAfterSec === 'number') {
    ;(err as Error & { retryAfterSec?: number }).retryAfterSec = retryAfterSec
  }
  return err
}

/**
 * 失败 Top 用的短码：HTTP 错取状态码（`HTTP 429`），其余取错误消息前 40 字。
 * 只做归类不做展示 —— 界面要的是「哪个原因最多」，不是完整堆栈。
 */
export function errorCodeOf(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  const m = /^LLM 调用失败 HTTP (\d+)/.exec(msg)
  if (m) return `HTTP ${m[1]}`
  return msg.replace(/\s+/g, ' ').trim().slice(0, 40)
}

/** 取错误上挂着的 Retry-After（没有则 undefined） */
export function retryAfterOf(err: unknown): number | undefined {
  const v = (err as { retryAfterSec?: number } | null)?.retryAfterSec
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** 从响应头取 Retry-After（秒或 HTTP 日期都支持，取不到返回 undefined） */
export function retryAfterSecOf(headers: { get(name: string): string | null }): number | undefined {
  const raw = headers.get('retry-after')
  if (!raw) return undefined
  const sec = Number(raw.trim())
  if (Number.isFinite(sec) && sec >= 0) return sec
  const at = Date.parse(raw)
  if (Number.isFinite(at)) return Math.max(0, (at - Date.now()) / 1000)
  return undefined
}
