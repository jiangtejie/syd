import * as wxService from '../wechat/wxService'
import { createAiProvider } from '../ai/provider'
import { getTeamUsernamesCached } from '../../db/repos/teamRepo'
import {
  clearIssues,
  listIssues,
  setIssueStatus,
  typeCounts,
  upsertIssue,
  listOpenUnrepliedByGroup,
  findIssueByKey,
  openIssueEvidenceTimes,
  openIssuesForGroup,
  clearOpenIssuesByGroup,
  type NewIssue
} from '../../db/repos/issueRepo'
import { getConfig, setConfig } from '../../db/repos/config'
import type {
  ChatMessage,
  FeedbackAnalysisState,
  FeedbackIssue,
  FeedbackIssueMsg,
  FeedbackIssueStatus,
  FeedbackIssueType
} from '../../../shared/types'

/**
 * 群问题反馈分析器（看板 + 工作台）。
 * - 窗口：近 N 天（自然日）内活跃的群会话；
 * - 方式：OpenAI 兼容 LLM 分类提取；未配置/失败时按群回退本地规则（关键词 + 末尾未回复）；
 * - 「已跟进」判定为会话语义：客户消息之后、下一条客户消息之前出现我方/团队客服消息即视为已回复，
 *   不设固定时间窗（隔夜/超 30 分钟回复不再误报）；
 * - 团队客服成员（手动全局标识）的消息视同我方；
 * - unreplied 问题自动闭环：后续分析检测到锚点消息后有客服回复 → 自动 done（autoDone 标记）；
 * - 落库策略：稳定 key upsert，重复分析不重置人工处理状态。
 */

const WINDOW_DAYS = 7
/** 单群扫描消息上限（窗口内消息超限时保留最新） */
const MAX_GROUP_MSGS = 800
/** LLM 每群输入行数上限（超窗截断取最新，避免超长） */
const LLM_LINES_CAP = 220
/** 分析的群数上限（按活跃度取最新） */
const MAX_GROUPS = 30
/** 工作台单群分析节流：距上次尝试（成功或失败）短于该值时自动触发直接跳过（force 忽略） */
const GROUP_AUTO_REANALYZE_MS = 2 * 60_000
/** 单群分析尝试记录配置键（工作台「切群自动分析」防抖与失败信息透传） */
const groupStampKey = (wxid: string, group: string): string => `issue.groupAt:${wxid}:${group}`

export const ISSUE_TYPES: FeedbackIssueType[] = [
  '客诉',
  '售后',
  '物流',
  '价格',
  '咨询',
  '建议',
  '其他'
]

/** 本地兜底规则：命中即归类，文本仅在客户消息上匹配 */
const RULE_KEYWORDS: Array<{ type: FeedbackIssueType; keywords: string[] }> = [
  {
    type: '客诉',
    keywords: ['投诉', '差评', '垃圾', '太差', '翻车', '气死', '失望', '再也不买', '质量问题']
  },
  {
    type: '售后',
    keywords: ['退货', '退款', '换货', '维修', '质保', '保修', '三包', '售后']
  },
  {
    type: '物流',
    keywords: ['快递', '物流', '发货', '配送', '签收', '没到', '包裹', '运单', '迟迟不发', '截单']
  },
  {
    type: '价格',
    keywords: ['太贵', '价格', '优惠', '折扣', '差价', '涨价', '优惠券', '划算吗', '便宜点']
  },
  {
    type: '建议',
    keywords: ['建议', '希望', '能不能加', '期待', '优化', '要是能']
  },
  {
    type: '咨询',
    keywords: ['请问', '怎么', '如何', '可以吗', '什么时候', '多少钱', '在哪', '能用吗', '有没有', '支持吗']
  }
]

/** 单条消息转人类可读文本（供 LLM 上下文与规则匹配） */
function msgToText(m: ChatMessage): string {
  switch (m.localType) {
    case 1:
      return m.parsedContent || '[文本]'
    case 3:
      return '[图片]'
    case 34:
      return '[语音]'
    case 43:
      return '[视频]'
    case 47:
      return '[表情]'
    default:
      return m.parsedContent || '[消息]'
  }
}

function msgToSummaryMsg(m: ChatMessage, senderName: string): FeedbackIssueMsg {
  return {
    time: m.createTime,
    senderName,
    isSend: m.isSend,
    text: msgToText(m),
    imageMd5: m.imageMd5,
    localType: m.localType
  }
}

/** 归一化发送者名：我方消息固定名；团队客服同事标注；客户取昵称 */
function senderLabel(m: ChatMessage, team?: Set<string>): string {
  if (m.isSend) return '我方客服'
  const u = m.senderUsername
  if (team && u && team.has(u)) {
    const nick = m.senderNickname || u
    return nick === u ? '我方同事' : `我方同事（${nick}）`
  }
  return m.senderNickname || u || '客户'
}

/** LLM 上下文行消息过滤（真文本 + 带摘要的 appmsg + 图片） */
function isTextLike(m: ChatMessage): boolean {
  return m.localType === 1 || m.localType === 49
}

/** 规则模式只吃真文本（type 1）；49 型摘要（[链接]/[文件]/[聊天记录]/[转账]）会引入假关键词，不参与匹配 */
function isRuleText(m: ChatMessage): boolean {
  return m.localType === 1
}

/**
 * 会话语义「已跟进」判定：消息 idx 之后、下一条客户（非我方/非团队）消息之前，
 * 是否存在我方或团队客服消息。不再使用固定 30 分钟窗（隔夜/迟回复不误报）。
 */
function hasStaffReplyAfter(msgs: ChatMessage[], idx: number, team: Set<string>): boolean {
  for (let j = idx + 1; j < msgs.length; j++) {
    const x = msgs[j]
    const isStaff = x.isSend || (!!x.senderUsername && team.has(x.senderUsername))
    if (isStaff) return true
    // 系统消息等非客户对象不影响回合判定；遇到下一条客户消息仍未回复 → 视为未跟进
    if (!x.isSend && !x.senderUsername) continue
    if (!x.isSend) return false
  }
  return false
}

/** 收敛 LLM 输出类型到枚举 */
function normalizeType(t: string | undefined | null): FeedbackIssueType {
  const hit = ISSUE_TYPES.find((x) => x === t)
  if (hit) return hit
  const fuzzy = ISSUE_TYPES.find((x) => t?.includes(x))
  return fuzzy ?? '其他'
}

interface LlmIssue {
  type?: string
  title?: string
  summary?: string
  /** 议题涉及客户（昵称，辅助理解；不作为存储主键） */
  customers?: unknown
  /** 处理状态：未处理 | 跟进中 | 已解决 */
  status?: string
  /** 是否需要运营介入（false = 已闭环/无需处理，不落待办） */
  need_action?: unknown
  evidence?: number[]
}

function parseLlmJson(raw: string): LlmIssue[] {
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

/** 逐群读取窗口内消息（跨库自动分片分页，直到越过窗口起点或达上限） */
function readGroupMessages(wxid: string, groupUsername: string, windowStartMs: number): ChatMessage[] {
  const all: ChatMessage[] = []
  let cursor: Parameters<typeof wxService.getMessages>[3] = undefined
  for (;;) {
    const res = wxService.getMessages(wxid, groupUsername, 80, cursor)
    if (!res.ok || !res.messages || res.messages.length === 0) break
    const msgs = res.messages.filter((m) => m.createTime >= windowStartMs)
    all.unshift(...msgs) // 返回按时间升序，向后翻更旧页，因此插到头部
    const oldest = res.messages[0]
    // 已越过窗口起点 / 无更旧页 / 或已到限容：停止向后翻
    if (all.length >= MAX_GROUP_MSGS || !res.hasMore || !res.nextCursor || oldest.createTime < windowStartMs) {
      break
    }
    cursor = res.nextCursor
  }
  // 限容：超限时保留最新（时间升序 => 截尾部）
  return all.length > MAX_GROUP_MSGS ? all.slice(all.length - MAX_GROUP_MSGS) : all
}

/** 规则议题聚类窗：同一客户同一类型诉求间隔 ≤ 该值视为同一议题的多句跟进 */
const RULE_CLUSTER_MS = 60 * 60_000
/** 规则单议题证据消息上限 */
const RULE_EVIDENCE_CAP = 8

/**
 * 本地规则提取（议题级）：
 * 1) 关键词命中按「同一客户 + 同一类型 + 60 分钟窗」聚成议题（一次抱怨的多句/追问只建一条问题）；
 * 2) followUp=客服/团队在议题期间介入过但未闭环（不再简单跳过）；无介入=未处理；
 * 3) 末尾「客户留言无回复」兜底（与关键词议题去重）。
 */
function ruleExtract(msgs: ChatMessage[], team: Set<string>): NewIssue[] {
  interface RuleHit {
    i: number
    m: ChatMessage
    type: string
  }
  const hits: RuleHit[] = []
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    const u = m.senderUsername
    if (m.isSend || (u && team.has(u)) || !isRuleText(m)) continue
    const text = msgToText(m)
    const rule = RULE_KEYWORDS.find((r) => r.keywords.some((k) => text.includes(k)))
    if (!rule) continue
    hits.push({ i, m, type: rule.type })
  }
  // 聚类：同人同类型、与前一条命中间隔 ≤ 窗 → 同一议题
  const clusters: RuleHit[][] = []
  for (const h of hits) {
    const cur = clusters[clusters.length - 1]
    if (
      cur &&
      cur[0].m.senderUsername === h.m.senderUsername &&
      cur[0].type === h.type &&
      h.m.createTime - cur[cur.length - 1].m.createTime <= RULE_CLUSTER_MS
    ) {
      cur.push(h)
      continue
    }
    clusters.push([h])
  }

  const issues: NewIssue[] = []
  const clusterAnchorTimes = new Set<number>()
  for (const c of clusters) {
    const first = c[0].m
    const label = senderLabel(first, team)
    const text0 = msgToText(first)
    // 议题内任一句后有客服/团队介入（至下一位客户开口前）→ 跟进中
    const replied = c.some((h) => hasStaffReplyAfter(msgs, h.i, team))
    const evidMsgs = c.map((h) => h.m).slice(-RULE_EVIDENCE_CAP)
    const n = c.length
    const title =
      n > 1
        ? `${label}：${text0.slice(0, 16)}…（共 ${n} 句）`
        : `${label}：${text0.slice(0, 24)}`
    const summary =
      n > 1 ? evidMsgs.map((mm) => msgToText(mm)).join(' ｜ ').slice(0, 90) : text0.slice(0, 80)
    for (const h of c) clusterAnchorTimes.add(h.m.createTime)
    issues.push({
      key: `${c[0].type}|${first.createTime}|${first.localId}`,
      wxid: '',
      groupUsername: '',
      groupName: '',
      type: c[0].type as FeedbackIssueType,
      title,
      summary,
      occurAt: first.createTime,
      method: 'rule',
      followUp: replied,
      msgs: evidMsgs.map((mm) => msgToSummaryMsg(mm, senderLabel(mm, team)))
    })
  }

  // 末尾「客户留言无回复」：窗内最后一条客户真文本消息，不属于任何关键词议题，且仍无我方/团队回复
  let tailIdx = -1
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    const u = m.senderUsername
    if (!m.isSend && !(u && team.has(u)) && isRuleText(m)) {
      tailIdx = i
      break
    }
  }
  const tail = tailIdx >= 0 ? msgs[tailIdx] : undefined
  if (
    tail &&
    !clusterAnchorTimes.has(tail.createTime) &&
    !hasStaffReplyAfter(msgs, tailIdx, team)
  ) {
    issues.push({
      key: `unreplied:${tail.createTime}`,
      wxid: '',
      groupUsername: '',
      groupName: '',
      type: '咨询',
      title: `${senderLabel(tail, team)}：${msgToText(tail).slice(0, 24)}`,
      summary: '客户留言后未见客服（或团队）回复',
      occurAt: tail.createTime,
      method: 'rule',
      msgs: [msgToSummaryMsg(tail, senderLabel(tail, team))]
    })
  }
  return issues
}

/** LLM 输入行解析器：主区行号 < 主区长度；附录行号 ≥ APX_BASE(1000) */
export interface LlmLineRef {
  msg: ChatMessage
  senderName: string
  /** 行文本（含时间前缀） */
  text: string
}
export type LlmLineResolver = (idx: number) => LlmLineRef | undefined

/** 归一化：规则结果补全账号/群；LLM 结果把行号（含附录偏移）映射回消息 */
function normalizeIssues(
  wxid: string,
  groupUsername: string,
  groupName: string,
  resolver: LlmLineResolver | null,
  extracted: unknown[],
  method: 'llm' | 'rule'
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
    const key = `llm:${wxid}:${groupUsername}:${first.createTime}:${first.localId}`
    if (seenKeys.has(key)) continue // 同一问题被模型拆成多条时只保留首条
    seenKeys.add(key)
    // 议题级判定：状态/是否需运营介入（已解决或无需处理 → resolved，落库侧自动闭环/不新建）
    const rawStatus = String(raw.status ?? '').trim()
    const followUp = rawStatus === '跟进中' || rawStatus === '进行中'
    const needAction = raw.need_action !== false && String(raw.need_action ?? '').toLowerCase() !== 'false'
    const resolved = !needAction || rawStatus === '已解决' || rawStatus === '解决'
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
      followUp,
      resolved,
      msgs: evidenceIdx.map((i) => {
        const it = resolver(i)!
        return msgToSummaryMsg(it.msg, it.senderName)
      })
    })
  }
  return issues
}

/** 会话段切分：消息间隔 ≥ 该值视为新一段（沉默分隔话题） */
const SEGMENT_GAP_MS = 15 * 60_000

/** 输入行（过滤后）按时间切段，供 LLM 以「段」为单位整体理解 */
function segmentizeLines(
  lines: Array<{ msg: ChatMessage }>
): Array<{ start: number; end: number }> {
  const segs: Array<{ start: number; end: number }> = []
  let s = 0
  for (let i = 1; i <= lines.length; i++) {
    if (
      i === lines.length ||
      lines[i].msg.createTime - lines[i - 1].msg.createTime >= SEGMENT_GAP_MS
    ) {
      segs.push({ start: s, end: i })
      s = i
    }
  }
  return segs
}

/** 附录行号起点：主区行号 < LLM_LINES_CAP(220)，附录行号从该值起，evidence 可引用 */
const APX_BASE = 1000
const APX_MAX = 80
/** 增量模式的尾巴保留行数（上次分析点前未成议题的对话，作为新进展的上下文） */
const INCR_TAIL_ROWS = 40

interface LlmRow {
  msg: ChatMessage
  senderName: string
  text: string
}

function fmtRow(m: ChatMessage, team: Set<string>): LlmRow {
  return {
    msg: m,
    senderName: senderLabel(m, team),
    text: `${new Date(m.createTime).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    })} ${senderLabel(m, team)}: ${msgToText(m)}`
  }
}

/**
 * 议题级 LLM 分析（主区 = 本次新增/窗口内消息，按段排版；
 * 附录 = 历史/上下文行，行号 ≥ APX_BASE，供模型理解延续议题与闭环判断）。
 * openHints：本群现存待办议题标题（抑制重复建与标题漂移）。
 */
async function analyzeLlmIssues(
  wxid: string,
  groupUsername: string,
  groupName: string,
  mainRows: LlmRow[],
  apxRows: LlmRow[],
  openHints: string[]
): Promise<NewIssue[]> {
  const main = mainRows.length > LLM_LINES_CAP ? mainRows.slice(mainRows.length - LLM_LINES_CAP) : mainRows
  const apx = apxRows.length > APX_MAX ? apxRows.slice(apxRows.length - APX_MAX) : apxRows
  if (main.length === 0 && apx.length === 0) return []

  const parts: string[] = []
  const segs = segmentizeLines(main)
  for (const seg of segs) {
    const names = new Set<string>()
    for (let i = seg.start; i < seg.end; i++) names.add(main[i].senderName)
    const from = new Date(main[seg.start].msg.createTime)
    parts.push(
      `[段 ${parts.length + 1} | ${from.getMonth() + 1}月${from.getDate()}日 ${String(
        from.getHours()
      ).padStart(2, '0')}:${String(from.getMinutes()).padStart(2, '0')} | 参与：${Array.from(
        names
      ).join('、')}]`
    )
    for (let i = seg.start; i < seg.end; i++) parts.push(`[${i}] ${main[i].text}`)
  }
  if (apx.length > 0) {
    parts.push('')
    parts.push('[附录：历史/背景行（行号 ≥ 1000）。仅用于理解延续中的议题与判断是否已闭环；新进展都在主区。]')
    apx.forEach((r, k) => parts.push(`[${APX_BASE + k}] ${r.text}`))
  }
  const body = parts.join('\n')

  const system = [
    '你是资深微信客服运营分析员。用户会给出一段客户服务群聊天记录，',
    '主区记录按时间切成若干【会话段】（沉默分隔），每段开头有 [段 n | 时间 | 参与人] 标注，段内行形如 [i] HH:mm 发送者: 内容。',
    '其中“我方客服”和“我方同事（xxx）”都是我们这边的人，其余是客户/群友。',
    ...(openHints.length > 0
      ? ['', '本群当前待办议题（仅作防重复参考；若你识别的议题与下列是同一条，请把 evidence 含其最早行、沿用其主题，不要另起一条）:', ...openHints.map((h, i) => `- 待办${i + 1}: ${h}`)]
      : []),
    '',
    '工作方法（先整体理解，再逐议题提炼）：',
    '1. 先整体阅读，识别“议题”（起因、多人附和、客服介入、追问与结果可跨行跨段合并为一条）；',
    '   同一客户围绕同一件事的多条消息必须串成一条议题，禁止一条消息单独成问题；',
    '2. 对每个议题判断：谁在抱怨/咨询（customers）、客服/团队是否已介入、客户是否已收尾；',
    '3. 只需提取仍需要运营处理或值得记录的议题。已明确解答且客户致谢/确认满意的不要输出；纯闲聊、广告、表情、与运营无关的不输出。',
    '',
    '只输出严格 JSON 数组（不要 markdown、不要额外文字）：',
    '[{"type":"客诉|售后|物流|价格|咨询|建议|其他","title":"不超过24字的概括","summary":"不超过70字的现象与进展","customers":["客户昵称"],"status":"未处理|跟进中|已解决","need_action":true,"evidence":[行号1,行号2]}]',
    '字段约束：',
    '- evidence 给该议题全部关键行（可跨段、可含 ≥1000 的附录行，1~12 个），行号必须真实存在；',
    '- status=已解决 或 need_action=false：已闭环/无需运营，不会出现在待办里；',
    '- status=跟进中：客服已回复但客户未确认闭环（如“查一下回复您”后无下文、客户仍不满）；',
    '- status=未处理：无人回复或明显遗漏；',
    '- 宁可少而准，不要虚构与拆分。'
  ].join('\n')

  const provider = createAiProvider()
  if (!provider) return []
  const raw = await provider.complete(system, body, { maxTokens: 1800 })
  const parsed = parseLlmJson(raw)
  const resolver = (idx: number): LlmLineRef | undefined => {
    if (idx >= 0 && idx < main.length) {
      const r = main[idx]
      return { msg: r.msg, senderName: r.senderName, text: r.text }
    }
    if (idx >= APX_BASE && idx - APX_BASE < apx.length) {
      const r = apx[idx - APX_BASE]
      return { msg: r.msg, senderName: r.senderName, text: r.text }
    }
    return undefined
  }
  return normalizeIssues(wxid, groupUsername, groupName, resolver, parsed, 'llm')
}

/** 自动闭环回溯上限：锚点早于该时限的问题不再回溯读取，直接视为超期 */
const AUTO_CLOSE_MAX_AGE_MS = 14 * 24 * 3600_000

/**
 * 自动闭环：对仍 open 的 unreplied 问题检查锚点消息后是否已出现客服/团队回复，
 * 有则自动 done（autoDone 标记，UI 区分「自动解决」）。
 * 锚点早于回溯上限（无法在读取范围内找到）时视为超期未跟进 → 自动搁置。
 * msgs 需覆盖锚点（analyzeOneGroup 会扩展读取窗口）。
 */
function autoCloseUnreplied(
  wxid: string,
  groupUsername: string,
  msgs: ChatMessage[],
  team: Set<string>
): number {
  const pend = listOpenUnrepliedByGroup(wxid, groupUsername)
  const now = Date.now()
  let closed = 0
  for (const p of pend) {
    // 锚消息 = 该时间点的客户消息（±1s 容差，防库时间精度差异）
    let anchorIdx = -1
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i]
      if (m.isSend) continue
      if (Math.abs(m.createTime - p.occurAt) <= 1000 && isRuleText(m)) {
        anchorIdx = i
        break
      }
    }
    if (anchorIdx < 0) {
      // 超出回溯范围仍未跟进：超期自动搁置（不再打扰，也不谎报"已回复"）
      if (now - p.occurAt > AUTO_CLOSE_MAX_AGE_MS) {
        setIssueStatus(p.id, 'stalled', true)
        closed++
      }
      continue
    }
    const staffLater = msgs
      .slice(anchorIdx + 1)
      .some((x) => x.isSend || (!!x.senderUsername && team.has(x.senderUsername)))
    if (staffLater) {
      setIssueStatus(p.id, 'done', true)
      closed++
    }
  }
  return closed
}

/** 读取某群最近一次分析尝试记录（成功或失败；失败携带 error 供 UI 透传） */
function readGroupStamp(
  wxid: string,
  groupUsername: string
): { at: number; method?: 'llm' | 'rule'; count?: number; error?: string } | null {
  const raw = getConfig(groupStampKey(wxid, groupUsername))
  if (!raw) return null
  try {
    const p = JSON.parse(raw) as {
      at?: number
      method?: string
      count?: number
      error?: string
    }
    if (typeof p.at !== 'number') return null
    return {
      at: p.at,
      method: p.method === 'llm' || p.method === 'rule' ? p.method : undefined,
      count: typeof p.count === 'number' ? p.count : undefined,
      error: p.error
    }
  } catch {
    return null
  }
}

const groupRunKeys = new Map<string, Promise<AnalyzeGroupResult>>()

export interface AnalyzeGroupResult {
  ok: boolean
  error?: string
  skipped?: boolean
  method?: 'llm' | 'rule'
  count?: number
  lastAt?: number
}

// ── 增量水位（防重复解读/防漏读）──

/** 增量尾巴回看时长：新进展的上下文（结合 INCR_TAIL_ROWS 行数共同生效） */
const INCR_TAIL_MS = 3 * 3600_000
const wmKey = (wxid: string, group: string): string => `issue.wm:${wxid}:${group}`

function readWm(wxid: string, groupUsername: string): { at: number; msgTime: number } | null {
  const raw = getConfig(wmKey(wxid, groupUsername))
  if (!raw) return null
  try {
    const p = JSON.parse(raw) as { at?: number; msgTime?: number }
    if (typeof p.at === 'number' && typeof p.msgTime === 'number') {
      return { at: p.at, msgTime: p.msgTime }
    }
  } catch {
    /* ignore */
  }
  return null
}

/** 群消息库当前最新一条消息时间（peek 一页；读失败返回 null 表示不拦截） */
function peekLatestMsgTime(wxid: string, groupUsername: string): number | null {
  try {
    const res = wxService.getMessages(wxid, groupUsername, 80)
    if (!res.ok || !res.messages || res.messages.length === 0) return null
    return res.messages[res.messages.length - 1].createTime
  } catch {
    return null
  }
}

/** 全部读取消息 → LLM 文本行 */
function buildRows(msgs: ChatMessage[], team: Set<string>): LlmRow[] {
  return msgs.filter((m) => isTextLike(m) || m.localType === 3).map((m) => fmtRow(m, team))
}

/** LLM 不可用/失败时：规则全量（读取范围内，幂等） */
function fallbackRuleIssues(
  wxid: string,
  groupUsername: string,
  groupName: string,
  msgs: ChatMessage[],
  team: Set<string>
): NewIssue[] {
  return normalizeIssues(wxid, groupUsername, groupName, null, ruleExtract(msgs, team), 'rule')
}

/**
 * 单群分析（工作台「群问题」入口）—— 增量水位 SOP。
 * - 首次/force：全量（自然日窗口 days，并向前扩展到本群 open 议题最早证据与 unreplied 锚点，上限 14 天）；
 * - 增量（有水位且非 force）：先 peek 最新消息，水位后无新消息 → skipped（0 LLM，不重复解读）；
 *   有新消息 → 主区=水位后新行，附录=尾巴(3h/40 行)+open 议题证据行，上下文不截断；
 * - 分析成功推进水位（单调），失败不推进（下次补读，防漏）。
 * - 自动触发节流 2 分钟兜底；按群 in-flight 防重；与看板全量共用存储（key 消息锚定不重复建行）。
 */
export async function analyzeGroupIssues(
  wxid: string,
  groupUsername: string,
  groupName = '',
  opts: { days?: number; force?: boolean; reset?: boolean } = {}
): Promise<AnalyzeGroupResult> {
  if (!wxid || !groupUsername) return { ok: false, error: '缺少账号或群标识' }
  const days = Math.min(Math.max(Math.floor(opts.days ?? 2), 1), 30)
  const reset = !!opts.reset
  const force = !!opts.force || reset // 重算模式必然全量,避免「只清不扫」

  const stamp = readGroupStamp(wxid, groupUsername)
  if (!force && stamp && Date.now() - stamp.at < GROUP_AUTO_REANALYZE_MS) {
    return {
      ok: true,
      skipped: true,
      method: stamp.method,
      count: stamp.count,
      lastAt: stamp.at,
      error: stamp.error
    }
  }

  const runKey = `${wxid}|${groupUsername}`
  const inflight = groupRunKeys.get(runKey)
  if (inflight) {
    try {
      await inflight
    } catch {
      // 首发起方已返回错误
    }
    const last = readGroupStamp(wxid, groupUsername)
    return { ok: true, skipped: true, method: last?.method, count: last?.count, lastAt: last?.at }
  }

  const stampNow = (
    at: number,
    extra: { method?: 'llm' | 'rule'; count?: number; error?: string }
  ): void => {
    setConfig(
      groupStampKey(wxid, groupUsername),
      JSON.stringify({ at, method: extra.method, count: extra.count, error: extra.error ?? '' })
    )
  }

  const run = (async (): Promise<AnalyzeGroupResult> => {
    const startedAt = Date.now()
    try {
      // 0) 重算模式:清空该群 open(待处理/跟进中)与其证据,再重新提取(已解决/归档保留)
      if (reset) {
        clearOpenIssuesByGroup(wxid, groupUsername)
      }
      // 1) 水位判定：增量模式且水位后无新消息 → 跳过（不重复解读）
      const wm = readWm(wxid, groupUsername)
      let incremental = false
      if (!force && wm) {
        const latest = peekLatestMsgTime(wxid, groupUsername)
        if (latest !== null && latest <= wm.msgTime) {
          return { ok: true, skipped: true, lastAt: wm.at }
        }
        incremental = true
      }

      // 2) 读取窗口：主分析起点 + 向前扩展（open 议题证据 / unreplied 锚，上限 14 天）
      const today = new Date(startedAt)
      today.setHours(0, 0, 0, 0)
      const base = today.getTime() - (days - 1) * 24 * 3600_000
      const oldestAllowed = Date.now() - AUTO_CLOSE_MAX_AGE_MS
      const pend = listOpenUnrepliedByGroup(wxid, groupUsername)
      const openTimes = openIssueEvidenceTimes(wxid, groupUsername)
      let extendMs: number | null = null
      const consider = (t: number): void => {
        const cand = Math.max(t - 1, oldestAllowed)
        if (extendMs === null || cand < extendMs) extendMs = cand
      }
      for (const p of pend) consider(p.occurAt)
      for (const t of openTimes) consider(t)

      const focusStart = incremental ? wm!.msgTime : base
      let readStart = incremental ? Math.max(wm!.msgTime - INCR_TAIL_MS, oldestAllowed) : base
      if (extendMs !== null && extendMs < readStart) readStart = extendMs
      readStart = Math.max(readStart, oldestAllowed)

      const msgs = readGroupMessages(wxid, groupUsername, readStart)
      const team = getTeamUsernamesCached(wxid)
      const provider = createAiProvider()
      if (msgs.length === 0) {
        const method: 'llm' | 'rule' = provider ? 'llm' : 'rule'
        stampNow(Date.now(), { method, count: 0 })
        return { ok: true, method, count: 0, lastAt: Date.now() }
      }
      const latestMsgTime = msgs[msgs.length - 1].createTime

      // 3) 主区/附录划分
      const allRows = buildRows(msgs, team)
      const mainRows: LlmRow[] = []
      const apxRows: LlmRow[] = []
      const preRows = allRows.filter((r) => r.msg.createTime < focusStart)
      const tailSet = new Set(
        preRows.slice(-INCR_TAIL_ROWS).map((r) => r.msg.createTime)
      )
      for (const r of allRows) {
        if (r.msg.createTime >= focusStart) mainRows.push(r)
        else if (openTimes.has(r.msg.createTime) || tailSet.has(r.msg.createTime)) {
          apxRows.push(r)
        }
      }
      // 兜底：主区为空（极端窗位）→ 全部当主区处理，避免漏读
      if (mainRows.length === 0 && allRows.length > 0) {
        mainRows.push(...allRows)
        apxRows.length = 0
      }

      // 4) LLM（议题级，含附录上下文）或规则降级
      let issues: NewIssue[] = []
      let method: 'llm' | 'rule' = 'rule'
      if (provider && mainRows.length > 0) {
        try {
          const openHints = openIssuesForGroup(wxid, groupUsername, 6).map(
            (i) => `[${i.type}] ${i.title}${i.followUp ? '（跟进中）' : ''}`
          )
          issues = await analyzeLlmIssues(
            wxid,
            groupUsername,
            groupName,
            mainRows,
            apxRows,
            openHints
          )
          method = 'llm'
        } catch {
          issues = fallbackRuleIssues(wxid, groupUsername, groupName, msgs, team)
        }
      } else if (msgs.length > 0) {
        issues = fallbackRuleIssues(wxid, groupUsername, groupName, msgs, team)
      }

      // 5) 落库 + resolved 自动闭环 + unreplied 自动闭环
      let n = 0
      for (const issue of issues) {
        if (issue.resolved) {
          const existing = findIssueByKey(issue.key)
          if (existing && existing.status === 'open') {
            setIssueStatus(existing.id, 'done', true)
          }
          continue
        }
        upsertIssue(issue)
        n++
      }
      if (pend.length > 0) autoCloseUnreplied(wxid, groupUsername, msgs, team)

      // 6) 成功推进水位（单调；失败不推进，下次自动补读）
      const prevWm = readWm(wxid, groupUsername)
      if (!prevWm || latestMsgTime > prevWm.msgTime) {
        setConfig(wmKey(wxid, groupUsername), JSON.stringify({ at: Date.now(), msgTime: latestMsgTime }))
      }
      stampNow(Date.now(), { method, count: n })
      return { ok: true, method, count: n, lastAt: Date.now() }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      stampNow(Date.now(), { error })
      return { ok: false, error }
    }
  })()

  groupRunKeys.set(runKey, run)
  try {
    return await run
  } finally {
    groupRunKeys.delete(runKey)
  }
}

/** 分析并写库（带 in-flight 保护，按账号串行） */
const runningWxids = new Map<string, Promise<void>>()
/** 成功态（含 lastAt）配置键 */
const stateConfigKey = (wxid: string) => `issue.analyzed:${wxid}`
/** 失败标记配置键：失败不写 lastAt，仅标记，避免每次进入都重复自动全量扫描 */
const failConfigKey = (wxid: string) => `issue.analyzeFail:${wxid}`

export async function analyzeIssues(
  wxid: string
): Promise<{ ok: boolean; error?: string; state?: FeedbackAnalysisState }> {
  const inFlight = runningWxids.get(wxid)
  if (inFlight) {
    await inFlight
    return { ok: true, state: readState(wxid) }
  }
  let resolveRun!: () => void
  const runPromise = new Promise<void>((r) => (resolveRun = r))
  runningWxids.set(wxid, runPromise)
  try {
    const provider = createAiProvider()
    const method: 'llm' | 'rule' = provider ? 'llm' : 'rule'

    const sessionsRes = wxService.getSessions(wxid)
    if (!sessionsRes.ok || !sessionsRes.sessions) {
      return { ok: false, error: sessionsRes.error || '读取会话失败' }
    }
    const now = Date.now()
    const today = new Date(now)
    today.setHours(0, 0, 0, 0)
    const windowStart = today.getTime() - (WINDOW_DAYS - 1) * 24 * 3600_000

    const groups = sessionsRes.sessions
      .filter(
        (s) => s.isGroup && !s.isWeCom && s.lastTimestamp >= windowStart && s.displayName.trim() !== ''
      )
      .sort((a, b) => b.lastTimestamp - a.lastTimestamp)
      .slice(0, MAX_GROUPS)

    let upserted = 0
    // 逐群走 analyzeGroupIssues（force）：统一按群锁、自动闭环，避免与工作台单群分析并发撞车
    for (const g of groups) {
      const r = await analyzeGroupIssues(wxid, g.username, g.displayName, {
        days: WINDOW_DAYS,
        force: true
      })
      if (r.ok && r.count) upserted += r.count
    }

    const payload = { at: Date.now(), method, count: upserted }
    setConfig(stateConfigKey(wxid), JSON.stringify(payload))
    setConfig(failConfigKey(wxid), '') // 成功后清除历史失败标记
    const state: FeedbackAnalysisState = {
      running: false,
      wxid,
      method,
      lastAt: payload.at,
      issueCount: listIssues(wxid).length
    }
    return { ok: true, state }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    setConfig(failConfigKey(wxid), JSON.stringify({ at: Date.now(), error }))
    const state = readState(wxid)
    return { ok: false, error, state: { ...state, running: false } }
  } finally {
    runningWxids.delete(wxid)
    resolveRun()
  }
}

/** 读取最近一次分析记录（app_config 持久化；失败标记会随 state.error 返回） */
export function readState(wxid: string): FeedbackAnalysisState {
  const state: FeedbackAnalysisState = { running: runningWxids.has(wxid), wxid }
  const raw = getConfig(stateConfigKey(wxid))
  if (raw) {
    try {
      const p = JSON.parse(raw) as { at?: number; method?: string }
      if (p.method === 'llm' || p.method === 'rule') state.method = p.method
      if (typeof p.at === 'number') state.lastAt = p.at
      state.issueCount = listIssues(wxid).length
    } catch {
      // 配置损坏则仅返回运行态
    }
  }
  const failRaw = getConfig(failConfigKey(wxid))
  if (failRaw) {
    try {
      const f = JSON.parse(failRaw) as { error?: string }
      if (f.error) state.error = f.error.slice(0, 200)
    } catch {
      state.error = '上次分析失败'
    }
  }
  return state
}

export function listFeedbackIssues(wxid: string): FeedbackIssue[] {
  return listIssues(wxid)
}

export function updateIssueStatus(id: number, status: FeedbackIssueStatus): void {
  setIssueStatus(id, status)
}

/** 清空某账号的问题数据并复位分析/失败标记（下次分析从真实群消息重新提取） */
export function clearFeedbackIssues(wxid: string): void {
  clearIssues(wxid)
  setConfig(stateConfigKey(wxid), '')
  setConfig(failConfigKey(wxid), '')
}

export function issueTypeCounts(wxid: string) {
  return typeCounts(wxid)
}
