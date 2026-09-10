/**
 * 议题同一性判据（实时合并与存量去重共用；纯函数、零 IO，便于用真实数据标定与单测）。
 *
 * 背景：LLM 提取的 key 锚定「最早证据行」，锚点一漂移就会为同一议题再建一行。实测（37 条 open）：
 *  - 只靠「同群 + 同类型 + 客户 + 时间邻近」对长议题不够：同一议题实测跨 15 小时、甚至 4 天；
 *  - 只靠「证据重叠」又会误合并同一段对话里的两个主题（缺货催发货 vs 多付钱退款，共享 4 条消息）。
 * 因此用三个互相独立的信号组合判定，任一组合命中即视为同一议题：
 *  - 标题相似度（字符 bigram Jaccard）：真重复 0.40~1.00，不同主题 ≤0.20（实测分界清晰）；
 *  - 证据重叠：引用同一批消息（不受时间跨度限制，长议题靠它）；
 *  - 客户身份（昵称或 username）+ 同类型 + 时间邻近：规则提取的标题是原文摘录，只能靠这组信号补。
 */

/** 同一性判定所需的议题事实（调用方从库/新建议题映射而来） */
export interface TopicFacts {
  /** 标题（LLM 概括或规则原文摘录） */
  title: string
  /** 议题类型（客诉/售后/物流/价格/咨询/建议/其他） */
  type: string
  /** 客户昵称（持久化字段） */
  customers?: string[]
  /** 客户 username（新写入的证据行才有；比昵称稳定） */
  usernames?: string[]
  /** 证据消息时间（毫秒） */
  evidenceTimes: number[]
  /** 首现时间（毫秒；用于时间邻近判定，可缺省） */
  occurAt?: number
}

export interface TopicMatch {
  /** 是否同一议题 */
  same: boolean
  /** 命中的判据（写明理由便于人工复核/预览） */
  reason: string
  /**
   * 是否**高置信**同一议题：证据几乎完全重合 / 标题高度一致 / 同客户同类型且证据被包含。
   * 高置信才允许后台自动合并；仅靠「时间邻近」命中的一律留给人工预览确认。
   */
  strong: boolean
}

/** 标题相似度阈值（实测：真重复 ≥0.40，不同主题 ≤0.20） */
const TITLE_SAME = 0.4
/** 高置信标题阈值：措辞几乎逐字一致 */
const TITLE_STRONG = 0.6
/** 「身份+同类型+时间邻近」兜底窗口（未回复留言类由调用方放宽到 72h） */
export const TOPIC_TIME_NEAR_MS = 6 * 3600_000
const TIME_NEAR_MS = TOPIC_TIME_NEAR_MS

/** 归一化：去掉空白与标点，只留字面内容 */
function normalizeTitle(s: string): string {
  return (s || '').replace(/[\s\p{P}\p{S}]/gu, '')
}

/** 字符 bigram 集合（中文短标题上比词级更稳） */
function bigrams(s: string): Set<string> {
  const t = normalizeTitle(s)
  const out = new Set<string>()
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2))
  return out
}

/** Jaccard 相似度（空集返回 0；完全一致返回 1） */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

/** 标题相似度：1 字标题退化为全等比较 */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a)
  const nb = normalizeTitle(b)
  if (!na || !nb) return 0
  if (na.length < 2 || nb.length < 2) return na === nb ? 1 : 0
  return jaccard(bigrams(a), bigrams(b))
}

/** 证据重叠：共享条数 + 相对较小一方的覆盖率（1 = 小集合被完全包含） */
export function evidenceOverlap(a: number[], b: number[]): { shared: number; cover: number } {
  if (a.length === 0 || b.length === 0) return { shared: 0, cover: 0 }
  const sb = new Set(b)
  let shared = 0
  for (const t of new Set(a)) if (sb.has(t)) shared++
  const minSize = Math.min(new Set(a).size, sb.size)
  return { shared, cover: minSize > 0 ? shared / minSize : 0 }
}

/** 客户身份是否有交叠（昵称或 username 任一命中） */
export function identityOverlap(a: TopicFacts, b: TopicFacts): boolean {
  const names = new Set((a.customers ?? []).map((x) => x.trim()).filter(Boolean))
  if (names.size > 0) {
    for (const n of b.customers ?? []) if (names.has(n.trim())) return true
  }
  const users = new Set((a.usernames ?? []).map((x) => x.trim()).filter(Boolean))
  if (users.size > 0) {
    for (const u of b.usernames ?? []) if (users.has(u.trim())) return true
  }
  return false
}

/**
 * 判定两条议题记录是否同一议题。调用方需保证二者同群（跨群不会同题）。
 * opts.maxTimeGapMs：覆盖「身份+同类型+时间邻近」兜底窗口（未回复留言类放宽到 72h）；
 * 传 ≤0 表示本次不比时间邻近（纯证据/标题判据）。
 */
export function topicSame(
  a: TopicFacts,
  b: TopicFacts,
  opts: { maxTimeGapMs?: number } = {}
): TopicMatch {
  if (!a.title && !b.title) return { same: false, reason: '', strong: false }
  const title = titleSimilarity(a.title, b.title)
  const { shared, cover } = evidenceOverlap(a.evidenceTimes, b.evidenceTimes)
  const identity = identityOverlap(a, b)
  const typeSame = !!a.type && a.type === b.type

  // 逐条判据累积（不能命中即返回：弱判据先命中会把强判据的结论盖掉，
  // 例如「标题只 0.40 但证据 4 条全覆盖、同客户同类型」本该是高置信，短路后就变成弱信号了）
  const hits: string[] = []
  let same = false
  let strong = false
  const mark = (isSame: boolean, isStrong: boolean, reason: string): void => {
    if (!isSame) return
    same = true
    if (isStrong) strong = true
    // 强判据排前面：预览里只显示前两条理由，得先说清楚「凭什么认定是同一条」
    if (isStrong) hits.unshift(reason)
    else hits.push(reason)
  }

  // ① 主题措辞一致 + （同一客户 或 证据有交集）：防止「不同客户问法相似」被误并成一条
  mark(
    title >= TITLE_SAME && (identity || shared >= 1),
    title >= TITLE_STRONG && (identity || shared >= 2),
    `标题相似 ${title.toFixed(2)}${identity ? '+同客户' : ''}${shared ? `+共享证据${shared}条` : ''}`
  )
  // ② 同一客户 + 同类型 + 证据大幅重叠（长议题：跨天漂移也认）
  mark(
    identity && typeSame && shared >= 2 && cover >= 0.6,
    shared >= 3 && cover >= 0.8,
    `同客户同类型+证据覆盖 ${(cover * 100) | 0}%(${shared}条)`
  )
  // ③ 同一客户 + 同类型 + 证据被完全包含（规则提取常只有 1~2 条证据）
  mark(
    identity && typeSame && shared >= 1 && cover >= 0.9,
    shared >= 2 || cover >= 1,
    `同客户同类型+证据包含(${shared}条)`
  )
  // ④ 同类型 + 证据高度一致（身份缺失时兜底）
  mark(
    typeSame && shared >= 3 && cover >= 0.8,
    shared >= 4 && cover >= 0.9,
    `同类型+证据高度重叠(${shared}条/${(cover * 100) | 0}%)`
  )
  // ⑤ 同一客户 + 同类型 + 时间邻近（无证据交集的短时重复：未回复留言跨天收拢）
  //    只有时间邻近 = 弱信号（可能是同一客户的两件同类事）：绝不自动合并
  const gap = opts.maxTimeGapMs ?? TIME_NEAR_MS
  if (gap > 0 && identity && typeSame && a.occurAt !== undefined && b.occurAt !== undefined) {
    const diff = Math.abs(a.occurAt - b.occurAt)
    if (diff <= gap) mark(true, false, `同客户同类型+时间邻近${Math.round(diff / 60000)}分`)
  }
  return { same, strong: same && strong, reason: hits.slice(0, 2).join(' + ') }
}

/**
 * 并查集聚类：把同一群内互相判为同议题的记录聚成组（供存量去重预览/执行）。
 * 调用方需先按群分组传入（跨群不会同题）；timeGapFor 可按对放宽/关闭时间邻近判据
 * （例如「未回复留言」跨天也算同一件事，其余只用 6h 邻近）。
 */
export function clusterTopics<T extends TopicFacts>(
  rows: T[],
  opts: {
    maxTimeGapMs?: number
    timeGapFor?: (a: T, b: T) => number
  } = {}
): Array<{ members: T[]; reasons: string[]; strong: boolean }> {
  const parent = new Map<number, number>()
  const find = (x: number): number => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r) as number
    let c = x
    while (parent.get(c) !== c) {
      const next = parent.get(c) as number
      parent.set(c, r)
      c = next
    }
    return r
  }
  rows.forEach((_, i) => parent.set(i, i))
  const reasons: string[] = []
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const gap = opts.timeGapFor ? opts.timeGapFor(rows[i], rows[j]) : opts.maxTimeGapMs
      const m = topicSame(rows[i], rows[j], { maxTimeGapMs: gap })
      if (!m.same) continue
      const a = find(i)
      const b = find(j)
      if (a !== b) parent.set(a, b)
      reasons.push(m.reason)
    }
  }
  const groups = new Map<number, T[]>()
  rows.forEach((r, i) => {
    const root = find(i)
    const arr = groups.get(root)
    if (arr) arr.push(r)
    else groups.set(root, [r])
  })
  const toFacts = (r: T): TopicFacts => r
  return Array.from(groups.values())
    .filter((g) => g.length > 1)
    .map((members) => ({ members, reasons: Array.from(new Set(reasons)) }))
    .map((g) => {
      // 强连通判定：只用强信号在簇内再走一遍连通性，全连通才允许后台自动合并
      const seen = new Set<number>([0])
      const stack = [0]
      while (stack.length > 0) {
        const i = stack.pop() as number
        for (let j = 0; j < g.members.length; j++) {
          if (seen.has(j)) continue
          const gap = opts.timeGapFor
            ? opts.timeGapFor(g.members[i], g.members[j])
            : opts.maxTimeGapMs
          if (
            !topicSame(toFacts(g.members[i]), toFacts(g.members[j]), { maxTimeGapMs: gap }).strong
          ) {
            continue
          }
          seen.add(j)
          stack.push(j)
        }
      }
      return { members: g.members, reasons: g.reasons, strong: seen.size === g.members.length }
    })
}
