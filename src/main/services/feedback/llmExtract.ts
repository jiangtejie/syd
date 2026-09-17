/**
 * LLM 提取：分批消费主区、按段排版、证据行号回映射、议题级归一化。
 */
import { createAiProvider } from '../ai/provider'
import { fmtHms } from '../../../shared/monitorMetrics'
import type { NewIssue } from '../../db/repos/issueRepo'
import {
  LlmLineRef,
  LlmLineResolver,
  LlmRow,
  msgToSummaryMsg,
  normalizeSeverity,
  normalizeType,
  segmentizeLines
} from './shared'

/** LLM 每群输入行数上限（超窗截断取最新，避免超长） */
export const LLM_LINES_CAP = 220

/** 分批消费：主区超限时按段边界分批喂 LLM（每批≤该值），不再静默截断丢段 */
export const LLM_CHUNK_ROWS = 200

export interface LlmIssue {
  type?: string
  title?: string
  summary?: string
  /** 命中的现存待办议题编号（1 起，0/缺省 = 新议题）：用于复用既有 key，防重复建行 */
  topic?: unknown
  /** 严重度：紧急 | 高 | 一般 */
  severity?: unknown
  /** 议题涉及客户（昵称；持久化用于复发识别） */
  customers?: unknown
  /** 处理状态：未处理 | 跟进中 | 已解决 */
  status?: string
  /** 是否需要运营介入（false = 已闭环/无需处理，不落待办） */
  need_action?: unknown
  evidence?: number[]
}

export function parseLlmJson(raw: string): LlmIssue[] {
  let text = raw.trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fence) text = fence[1].trim()
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  const data = JSON.parse(text.slice(start, end + 1)) as unknown
  if (!Array.isArray(data)) return []
  return data.filter((d): d is LlmIssue => !!d && typeof d === 'object')
}

/** 归一化：规则结果补全账号/群；LLM 结果把行号（含附录偏移）映射回消息 */
export function normalizeIssues(
  wxid: string,
  groupUsername: string,
  groupName: string,
  resolver: LlmLineResolver | null,
  extracted: unknown[],
  method: 'llm' | 'rule',
  topicKeys: string[] = []
): NewIssue[] {
  if (method === 'rule') {
    // key 保留消息级锚点（type|时间|localId），避免窗口滑动造成序号漂移而重复建行
    return (extracted as NewIssue[]).map((it) => ({
      ...it,
      key: `rule:${wxid}:${groupUsername}:${it.key}`,
      wxid,
      groupUsername,
      groupName
    }))
  }
  const issues: NewIssue[] = []
  if (!resolver) return issues
  const seenKeys = new Set<string>()
  for (const raw of extracted as LlmIssue[]) {
    // evidence 按行号升序归一：key 锚定最早一条证据，模型证据顺序变化也不会导致 key 漂移
    const evidenceIdx = (raw.evidence ?? [])
      .filter((i) => Number.isInteger(i) && i >= 0 && resolver)
      .map((i) => ({ i, ref: resolver!(i) }))
      .filter((x): x is { i: number; ref: LlmLineRef } => !!x.ref)
      .map((x) => x.i)
      .sort((a, b) => a - b)
      .slice(0, 16)
    if (evidenceIdx.length === 0) continue
    const firstRef = resolver!(evidenceIdx[0])
    if (!firstRef) continue
    const first = firstRef.msg
    // 模型指认「与某条现存待办是同一条」时复用其 key：key 锚定最早证据行，
    // 一旦该行没进上下文，模型会另起一条 → 同一议题两行、旧的永不闭环
    const topicIdx = Math.floor(Number(raw.topic))
    const topicKey =
      Number.isInteger(topicIdx) && topicIdx >= 1 && topicIdx <= topicKeys.length
        ? topicKeys[topicIdx - 1]
        : null
    const key = topicKey ?? `llm:${wxid}:${groupUsername}:${first.createTime}:${first.localId}`
    if (seenKeys.has(key)) continue // 同一问题被模型拆成多条时只保留首条
    seenKeys.add(key)
    // 议题级判定：状态/是否需运营介入（已解决或无需处理 → resolved，落库侧自动闭环/不新建）
    const rawStatus = String(raw.status ?? '').trim()
    const followUp = rawStatus === '跟进中' || rawStatus === '进行中'
    const needAction =
      raw.need_action !== false && String(raw.need_action ?? '').toLowerCase() !== 'false'
    const resolved = !needAction || rawStatus === '已解决' || rawStatus === '解决'
    const rawCust = Array.isArray(raw.customers)
      ? raw.customers.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
      : []
    const customers = Array.from(new Set(rawCust.map((x) => x.trim()))).slice(0, 4)
    issues.push({
      key,
      wxid,
      groupUsername,
      groupName,
      type: normalizeType(raw.type),
      title: (raw.title || '').slice(0, 30) || `群内反馈（${groupName}）`,
      summary: (raw.summary || '').slice(0, 90) || undefined,
      occurAt: first.createTime,
      method: 'llm',
      severity: normalizeSeverity(String(raw.severity ?? '')),
      customers,
      followUp,
      resolved,
      msgs: evidenceIdx.map((i) => {
        const it = resolver(i)!
        return msgToSummaryMsg(it.msg, it.senderName, it.senderIsTeam)
      })
    })
  }
  return issues
}

/**
 * 主区按「会话段」边界分批：一批 ≤ LLM_CHUNK_ROWS 行。
 * 单批不超 LLM_LINES_CAP → analyzeLlmIssues 内部不再截断；多批时后一批携带前批落库后的 openHints，
 * 跨批的「客户诉求 → 客服回复」仍能被下一批识别闭环，杜绝高活跃群“截断即丢段”。
 */
export function chunkMainRows(main: LlmRow[]): LlmRow[][] {
  if (main.length <= LLM_CHUNK_ROWS) return [main]
  const out: LlmRow[][] = []
  const segs = segmentizeLines(main.map((r) => ({ msg: r.msg })))
  let cur: LlmRow[] = []
  const flush = (): void => {
    if (cur.length > 0) out.push(cur)
    cur = []
  }
  for (const seg of segs) {
    for (let i = seg.start; i < seg.end; i++) {
      cur.push(main[i])
      if (cur.length >= LLM_CHUNK_ROWS) flush()
    }
  }
  flush()
  return out.length > 0 ? out : [main]
}

/** 附录行号起点：主区行号 < LLM_LINES_CAP(220)，附录行号从该值起，evidence 可引用 */
export const APX_BASE = 1000

export const APX_MAX = 80

/**
 * 议题级 LLM 分析（主区 = 本次新增/窗口内消息，按段排版；
 * 附录 = 历史/上下文行，行号 ≥ APX_BASE，供模型理解延续议题与闭环判断）。
 * openHints：本群现存待办议题标题（抑制重复建与标题漂移）。
 * badExamples：近期被人工判定「不是问题」的样本（抑制同类误报）。
 */
export async function analyzeLlmIssues(
  wxid: string,
  groupUsername: string,
  groupName: string,
  mainRows: LlmRow[],
  apxRows: LlmRow[],
  openHints: string[],
  badExamples: string[] = [],
  topicKeys: string[] = []
): Promise<NewIssue[]> {
  const main =
    mainRows.length > LLM_LINES_CAP ? mainRows.slice(mainRows.length - LLM_LINES_CAP) : mainRows
  const apx = apxRows.length > APX_MAX ? apxRows.slice(apxRows.length - APX_MAX) : apxRows
  if (main.length === 0 && apx.length === 0) return []

  const parts: string[] = []
  const segs = segmentizeLines(main)
  for (const seg of segs) {
    const names = new Set<string>()
    for (let i = seg.start; i < seg.end; i++) names.add(main[i].senderName)
    const from = new Date(main[seg.start].msg.createTime)
    const segAt = `${from.getMonth() + 1}月${from.getDate()}日 ${fmtHms(from.getTime())}`
    parts.push(`[段 ${parts.length + 1} | ${segAt} | 参与：${Array.from(names).join('、')}]`)
    for (let i = seg.start; i < seg.end; i++) parts.push(`[${i}] ${main[i].text}`)
  }
  if (apx.length > 0) {
    parts.push('')
    parts.push(
      '[附录：历史/背景行（行号 ≥ 1000）。仅用于理解延续中的议题与判断是否已闭环；新进展都在主区。]'
    )
    apx.forEach((r, k) => parts.push(`[${APX_BASE + k}] ${r.text}`))
  }
  const body = parts.join('\n')

  const system = [
    '你是资深微信客服运营分析员。用户会给出一段客户服务群聊天记录，',
    '主区记录按时间切成若干【会话段】（沉默分隔），每段开头有 [段 n | 时间 | 参与人] 标注，段内行形如 [i] HH:mm 发送者: 内容。',
    '其中“我方客服”和“我方同事（xxx）”都是我们这边的人，其余是客户/群友。',
    ...(openHints.length > 0
      ? [
          '',
          '本群当前待办议题（防重复用）：若你识别的议题与下列某条是同一条，请沿用其主题、evidence 含其最早行，',
          '并在 topic 字段填它的编号（#2 就填 2），不要另起一条:',
          ...openHints.map((h, i) => `- 待办#${i + 1}: ${h}`)
        ]
      : []),
    ...(badExamples.length > 0
      ? [
          '',
          '以下为近期被人工判定「不是问题/无需处理」的同群样本（反例）：',
          ...badExamples.map((s, i) => `- 反例${i + 1}: ${s}`),
          '除非新消息是与上述明显不同的确凿真实反馈，否则不要输出同类内容。'
        ]
      : []),
    '',
    '工作方法（先整体理解，再逐议题提炼）：',
    '1. 先整体阅读，识别“议题”（起因、多人附和、客服介入、追问与结果可跨行跨段合并为一条）；',
    '   同一客户围绕同一件事的多条消息必须串成一条议题，禁止一条消息单独成问题；',
    '2. 对每个议题判断：谁在抱怨/咨询（customers）、客服/团队是否已介入、客户是否已收尾、紧急程度；',
    '3. 只需提取仍需要运营处理或值得记录的议题。已明确解答且客户致谢/确认满意的不要输出；纯闲聊、广告、表情、与运营无关的不输出。',
    '   以下也**不要**输出：纯应答与寒暄（收到/好的/谢谢/辛苦了）；事务性通知与业务往来（快递单号、发货通知、发票请查收、开票资料、对账单、收货确认）；',
    '   以及采购/供应链/内部协作类群里的下单、发运、对账等日常业务沟通 —— 它们不是客户诉求，输出只会堆出无法跟进的假待办。',
    '',
    '只输出严格 JSON 数组（不要 markdown、不要额外文字）：',
    '[{"type":"客诉|售后|物流|价格|咨询|建议|其他","severity":"紧急|高|一般","title":"不超过24字的概括","summary":"不超过70字的现象与进展","customers":["客户昵称"],"status":"未处理|跟进中|已解决","need_action":true,"topic":0,"evidence":[行号1,行号2]}]',
    '字段约束：',
    '- evidence 给该议题全部关键行（可跨段、可含 ≥1000 的附录行，1~12 个），行号必须真实存在；',
    '- topic：与上方「本群当前待办议题」中某条是同一件事时填该编号（1 起），否则填 0；',
    '- severity：紧急=激烈投诉/资金与时效受损/扬言曝光维权等需立即介入；高=客诉/售后/物流等需主动处理；一般=普通咨询与其他；',
    '- status=已解决 或 need_action=false：已闭环/无需运营，不会出现在待办里；',
    '- status=跟进中：客服已回复但客户未确认闭环（如“查一下回复您”后无下文、客户仍不满）；',
    '- status=未处理：无人回复或明显遗漏；',
    '- 宁可少而准，不要虚构与拆分。'
  ].join('\n')

  const provider = createAiProvider('issue-extract')
  if (!provider) return []
  const raw = await provider.complete(system, body, { maxTokens: 1800 })
  const parsed = parseLlmJson(raw)
  const resolver = (idx: number): LlmLineRef | undefined => {
    if (idx >= 0 && idx < main.length) {
      const r = main[idx]
      return { msg: r.msg, senderName: r.senderName, senderIsTeam: r.senderIsTeam, text: r.text }
    }
    if (idx >= APX_BASE && idx - APX_BASE < apx.length) {
      const r = apx[idx - APX_BASE]
      return { msg: r.msg, senderName: r.senderName, senderIsTeam: r.senderIsTeam, text: r.text }
    }
    return undefined
  }
  return normalizeIssues(wxid, groupUsername, groupName, resolver, parsed, 'llm', topicKeys)
}
