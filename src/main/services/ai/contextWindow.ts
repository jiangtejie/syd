/**
 * 上下文窗口与长会话压缩的**唯一口径**（纯函数，零 IO、零依赖，可离线自检）。
 *
 * 为什么要有它：工作台引擎（workbench/engine.ts）与 IM 助手引擎（chat/service.ts）
 * 原本各写了一遍同样的算法 —— 单条 6000 字截断、总量预算、40 条上限、
 * 「保留最近一半 + 旧段摘要」、每行 400 字、摘要输入 24k、摘要输出 1400 字。
 * 复制之后只有一边改了常量，于是缺陷只长在其中一份上：
 *  ① 工作台的裁剪上限 24k **小于**压缩触发阈值 36k，24k~36k 之间会先静默丢行、
 *     永远等不到压缩；助手侧预算 48k 大于阈值，同样的代码却没有这个 bug。
 *  ② 压缩可见性的修复也只落了一份（工作台落 compact 行 + 推事件，助手侧什么都没有）。
 *  ③ 两边都每轮拿全量历史重新摘要一次，长会话成本随轮次线性叠加。
 *
 * 这里把三条都收口：
 *  1. **触发阈值由预算派生**（预算 × 0.75），结构上保证「先压缩、后裁剪」，
 *     不可能再出现裁剪上限低于触发阈值的配置；超行数上限同样触发压缩而不是静默丢行。
 *  2. 裁剪结果显式回传 `dropped`，调用方必须让它在界面可见（不许静默）。
 *  3. 压缩带**水位**（`uptoId`）：已摘要过的行不再进摘要输入，每行最多被摘要一次。
 */

/** 单条消息最长保留字符（超长截断并加尾注） */
export const MAX_MSG_CHARS = 6000
/** 上下文最多保留多少条 */
export const MAX_ROWS = 40
/** 触发压缩的最少行数 */
export const COMPRESS_THRESHOLD_ROWS = 24
/**
 * 压缩触发阈值 = 预算 × 该比例。**必须 < 1**：
 * 等于或大于 1 就会退化成「先静默裁剪、永远等不到压缩」的历史故障。
 * 取 0.75 时助手侧 48k 预算恰好得到 36k —— 与它原本的阈值一致，行为不变。
 */
export const COMPRESS_BUDGET_RATIO = 0.75
/** 摘要输入里每行最多取多少字 */
export const SUMMARY_PER_ROW_CHARS = 400
/** 摘要输入总量上限（从尾部保留，即优先摘要较新的旧段） */
export const SUMMARY_INPUT_CHARS = 24_000
/** 摘要输出上限 */
export const SUMMARY_MAX_CHARS = 1400

/** 参与窗口规划的历史行（chat_message 的最小形状） */
export interface ContextRow {
  id: number
  role: string
  kind: string
  content: string
}

/** 压缩触发阈值：由预算派生，保证严格小于预算 */
export function compressThresholdChars(budgetChars: number): number {
  const budget = Number.isFinite(budgetChars) && budgetChars > 0 ? budgetChars : 0
  return Math.floor(budget * COMPRESS_BUDGET_RATIO)
}

export interface WindowPlan<T extends ContextRow> {
  /** 未摘要行的总字符数 */
  totalChars: number
  thresholdChars: number
  shouldCompress: boolean
  /** 本轮需要新摘要的行（水位之前的已摘要过，不再重复喂模型）；不压缩时为空 */
  toSummarize: T[]
  /** 压缩后保留的尾段；不压缩时 = 全部未摘要行 */
  tail: T[]
  /** 摘要输入文本（每行截断 + 总量上限），可直接喂模型；无待摘要行时为空串 */
  summaryInput: string
  /** 新水位：toSummarize 的最大 id；无新摘要时沿用传入的旧水位 */
  nextUptoId: number
}

/**
 * 规划本轮上下文：要不要压缩、摘要哪些行、保留哪一段。
 *
 * `uptoId` 是已持久化摘要覆盖到的最大消息 id（水位）。水位之前的行只活在摘要里，
 * 不再进上下文也不再进摘要输入 —— 这是「成本不随轮次线性叠加」的关键。
 */
export function planContextWindow<T extends ContextRow>(
  rows: T[],
  opts: { budgetChars: number; uptoId?: number; labelOf?: (row: T) => string }
): WindowPlan<T> {
  const uptoId = Number.isFinite(opts.uptoId) ? (opts.uptoId as number) : 0
  const thresholdChars = compressThresholdChars(opts.budgetChars)
  const fresh = rows.filter((r) => r.id > uptoId)
  const totalChars = fresh.reduce((n, r) => n + r.content.length, 0)
  // 超行数上限也要压缩：否则裁剪会按条数静默丢行（短消息长会话同样会踩）
  const shouldCompress =
    (fresh.length >= COMPRESS_THRESHOLD_ROWS && totalChars > thresholdChars) ||
    fresh.length > MAX_ROWS

  if (!shouldCompress) {
    return {
      totalChars,
      thresholdChars,
      shouldCompress: false,
      toSummarize: [],
      tail: fresh,
      summaryInput: '',
      nextUptoId: uptoId
    }
  }

  const keep = Math.ceil(fresh.length / 2)
  const toSummarize = fresh.slice(0, fresh.length - keep)
  const tail = fresh.slice(fresh.length - keep)
  return {
    totalChars,
    thresholdChars,
    shouldCompress: true,
    toSummarize,
    tail,
    summaryInput: buildSummaryInput(toSummarize, opts.labelOf),
    nextUptoId: toSummarize.length > 0 ? toSummarize[toSummarize.length - 1].id : uptoId
  }
}

/**
 * 单条截断 + 总量预算 + 条数上限：保留最新，超限从最旧丢弃。
 * 返回 `dropped` 让调用方能把「确实丢了历史」这件事说出来，而不是静默。
 */
export function trimByBudget<T extends { content: string }>(
  turns: T[],
  budgetChars: number,
  maxRows: number = MAX_ROWS
): { kept: T[]; dropped: number } {
  const kept: T[] = []
  let sum = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]
    const content =
      t.content.length > MAX_MSG_CHARS
        ? `${t.content.slice(0, MAX_MSG_CHARS)}\n…(超长已截断)`
        : t.content
    if (kept.length > 0 && sum + content.length > budgetChars) break
    kept.unshift({ ...t, content })
    sum += content.length
  }
  const capped = kept.length > maxRows ? kept.slice(kept.length - maxRows) : kept
  return { kept: capped, dropped: turns.length - capped.length }
}

/** 摘要输入：每行贴角色标签 + 截断，拼接后从尾部保留总量上限 */
export function buildSummaryInput<T extends ContextRow>(
  rows: T[],
  labelOf?: (row: T) => string
): string {
  const label = labelOf ?? ((r: T): string => (r.role === 'user' ? '用户' : '助手'))
  return rows
    .map((r) => {
      const c =
        r.content.length > SUMMARY_PER_ROW_CHARS
          ? `${r.content.slice(0, SUMMARY_PER_ROW_CHARS)}…`
          : r.content
      return `${label(r)}: ${c}`
    })
    .join('\n')
    .slice(-SUMMARY_INPUT_CHARS)
}

/** 摘要输出归一：去空白 + 上限；空串视为无摘要 */
export function normalizeSummary(text: unknown): string | null {
  const s = String(text ?? '')
    .trim()
    .slice(0, SUMMARY_MAX_CHARS)
  return s || null
}

/**
 * 合并旧摘要与本轮新摘要。
 * 旧摘要在前（时间更早），合并后仍受 SUMMARY_MAX_CHARS 约束 ——
 * 超限时**保留较新的部分**（近期结论比早期结论更有用），并标注早期已被压缩。
 */
export function mergeSummary(prev: string | null, next: string | null): string | null {
  const a = normalizeSummary(prev)
  const b = normalizeSummary(next)
  if (!a) return b
  if (!b) return a
  const joined = `${a}\n${b}`
  if (joined.length <= SUMMARY_MAX_CHARS) return joined
  return `（更早的对话已多轮压缩）\n${joined.slice(-(SUMMARY_MAX_CHARS - 16))}`
}
