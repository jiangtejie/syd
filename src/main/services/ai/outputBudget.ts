/**
 * 输出预算策略（**纯函数，零 IO、零依赖**，可离线自检）。
 *
 * 为什么要有它：思考型模型（DeepSeek Reasoner、Qwen 思考模式、GLM-Z、o 系列…）的思考过程
 * **会算进 maxOutputTokens**。调用点原本各自写死一个数（工作台 2400、JSON 路径 600），
 * 思考一长就把预算吃光，一个字正文都没写出来 —— 表现出来就是「模型未返回内容(预算或通道问题)」，
 * 用户既不知道原因，也不知道该改什么。
 *
 * 这里把「给多少预算」收敛成一条可自检的规则：
 *  1. 用户在设置里显式配了就以他为准；
 *  2. 没配时用调用点的默认值，但**模型名看着像思考型就抬到不至于被思考吃光的下限**；
 *  3. 第一次失败后按 4 倍递增（思考长度不可预测，只能失败一次就抬一档），直到硬上限。
 */

/** 思考型模型的兜底下限：思考常见 2k~8k tokens，低于这个数基本必然被吃光 */
export const REASONING_FLOOR = 8192
/** 硬上限：再高就不是「预算不够」，而是模型在跑飞了 */
export const BUDGET_CAP = 32768

/**
 * 模型名看着像思考型吗？
 * 注意：**名字认不出来不代表不会思考**（很多模型思考模式默认开着，名字里没有任何标记），
 * 所以它只用来避免「第一次就白跑」，真正的保险是失败后的自动放大。
 */
export function looksLikeReasoningModel(model: unknown): boolean {
  const m = String(model ?? '').toLowerCase()
  return /(reasoner|deepseek-r1|r1-|-r1|qwq|thinking|think|o1|o3|o4|glm-z|qvq|-think|magistral)/.test(
    m
  )
}

export type BudgetReason = 'configured' | 'fallback' | 'reasoning-boost' | 'escalated'

export interface OutputBudgetInput {
  /** 设置里的 ai.maxOutputTokens（<=0 或空 = 未配置） */
  configured?: unknown
  /** 调用点默认预算 */
  fallback: number
  /** 模型名（用于识别思考型） */
  model?: unknown
  /** 第几次尝试（0 起；>0 表示上一轮把预算用完了） */
  attempt?: unknown
  /** 硬上限（默认 BUDGET_CAP） */
  cap?: unknown
}

export interface OutputBudget {
  maxTokens: number
  reason: BudgetReason
}

function intOr(v: unknown, fallback: number): number {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) ? n : fallback
}

export function planOutputBudget(input: OutputBudgetInput): OutputBudget {
  const cap = Math.min(Math.max(intOr(input.cap, BUDGET_CAP), 256), 200000)
  const configured = intOr(input.configured, 0)
  const fallback = Math.min(Math.max(intOr(input.fallback, 1024), 64), cap)

  let base = fallback
  let reason: BudgetReason = 'fallback'
  if (configured > 0) {
    // 用户显式配了就听他的：替他擅自加码会让他以为设置没生效（放大仍会在失败后发生）
    base = Math.min(configured, cap)
    reason = 'configured'
  } else if (looksLikeReasoningModel(input.model) && base < REASONING_FLOOR) {
    // 第一次就抬到下限：省掉一次注定失败的调用（用户至少要多等十几秒）
    base = Math.min(REASONING_FLOOR, cap)
    reason = 'reasoning-boost'
  }

  const attempt = Math.max(0, Math.min(intOr(input.attempt, 0), 6))
  const maxTokens = Math.min(base * Math.pow(4, attempt), cap)
  if (attempt > 0) reason = 'escalated'
  return { maxTokens: Math.max(64, Math.floor(maxTokens)), reason }
}

/**
 * 这轮是不是「预算被思考吃光了」？
 * 判据：正文为空，且**有思考过程或接口明确说被长度截断**。
 * 两者都没有时更可能是通道/结构问题，放大预算也救不了，不该重试。
 */
export function looksBudgetExhausted(input: {
  hasText: boolean
  reasoningChars?: number
  reasoningTokens?: number
  finishReason?: string | null
}): boolean {
  if (input.hasText) return false
  if (intOr(input.reasoningChars, 0) > 0 || intOr(input.reasoningTokens, 0) > 0) return true
  return input.finishReason === 'length'
}

/** 给用户看的诊断话术：带上真实数字，并说清下一步改什么 */
export function budgetExhaustedMessage(input: {
  maxTokens: number
  outputTokens?: number
  reasoningTokens?: number
  reasoningChars?: number
}): string {
  const bits = ['本次输出 ' + String(intOr(input.outputTokens, 0)) + ' tokens']
  if (intOr(input.reasoningTokens, 0) > 0) {
    bits.push('其中思考 ' + String(intOr(input.reasoningTokens, 0)) + ' tokens')
  } else if (intOr(input.reasoningChars, 0) > 0) {
    bits.push('其中思考过程约 ' + String(intOr(input.reasoningChars, 0)) + ' 字')
  }
  bits.push('预算上限 ' + String(intOr(input.maxTokens, 0)))
  return (
    '模型把输出预算用在思考上了，没有写出正文（' +
    bits.join('，') +
    '）。到 设置 → AI 助手 调高「输出预算」，或改用非思考模型后重试。'
  )
}
