import * as wxService from '../wechat/wxService'
import { createAiProvider } from '../ai/provider'
import { getTeamUsernamesCached } from '../../db/repos/teamRepo'
import {
  clearIssues,
  listIssues,
  setIssueStatus,
  setIssueFollowUp,
  upsertIssue,
  listOpenIssuesByGroup,
  findIssueByKey,
  getIssueMsgs,
  openTopicIndex,
  archiveDuplicates,
  applyIssueMerge,
  type OpenTopicRow,
  openIssueEvidenceTimes,
  openIssueAnchorTimes,
  openIssuesForGroup,
  clearOpenIssuesByGroup,
  findReopenCandidate,
  recentRejectedSamples,
  snapshotOpenManualFields,
  restoreManualFields,
  type ManualFieldSnapshot,
  type NewIssue
} from '../../db/repos/issueRepo'
import { getConfig, getConfigNumber, setConfig } from '../../db/repos/config'
import { clusterTopics, topicSame, TOPIC_TIME_NEAR_MS, type TopicFacts } from './issueSimilarity'
import { getDb } from '../../db/database'
import type {
  ChatMessage,
  FeedbackAnalysisState,
  FeedbackIssue,
  FeedbackIssueMsg,
  FeedbackIssueSeverity,
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
 * - **分工：规则管跟进、LLM 管闭环**——每轮分析对全部 open 问题做确定性判定，
 *   已回复 → 跟进中并记录回复时刻；未回复 → 待处理；客户静默超阈值 → 自动收尾(done/autoDone)；
 *   锚点超出回溯范围 → 超期自动搁置(stalled)。LLM 只负责语义闭环（客户确认/已解决）。
 * - 落库策略：稳定 key upsert（含 key 漂移兜底合并），重复分析不重置人工处理状态。
 */

const WINDOW_DAYS = 7
/** 单群扫描消息上限（窗口内消息超限时保留最新） */
const MAX_GROUP_MSGS = 800
/** 「客户留言未回复」议题的合并窗：同一客户跨天重复留言仍视为同一件事在等回复 */
const UNREPLIED_MERGE_MS = 72 * 3600_000
/** LLM 每群输入行数上限（超窗截断取最新，避免超长） */
const LLM_LINES_CAP = 220
/** 分批消费：主区超限时按段边界分批喂 LLM（每批≤该值），不再静默截断丢段 */
const LLM_CHUNK_ROWS = 200
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
    keywords: [
      '请问',
      '怎么',
      '如何',
      '可以吗',
      '什么时候',
      '多少钱',
      '在哪',
      '能用吗',
      '有没有',
      '支持吗'
    ]
  }
]

/** 严重度归一（收敛 LLM/规则输出；脏值回落 一般） */
function normalizeSeverity(s: string | null | undefined): FeedbackIssueSeverity {
  return s === '紧急' || s === '高' ? s : '一般'
}

/** 规则严重度基线：客诉/售后/物流默认 高，其余 一般 */
const RULE_SEV_BASE: Record<FeedbackIssueType, FeedbackIssueSeverity> = {
  客诉: '高',
  售后: '高',
  物流: '高',
  价格: '一般',
  咨询: '一般',
  建议: '一般',
  其他: '一般'
}

/** 规则情绪升级词：客户文本命中的任一即升 紧急（客服优先介入） */
const RULE_SEV_BOOST = [
  '马上',
  '立刻',
  '气死',
  '曝光',
  '12315',
  '投诉到',
  '退钱',
  '赔',
  '急',
  '现在就要',
  '必须处理',
  '再也不买'
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

/** 是否团队客服成员（我方同事）消息 */
function isTeamMsg(m: ChatMessage, team: Set<string>): boolean {
  return !m.isSend && !!m.senderUsername && team.has(m.senderUsername)
}

/**
 * 证据行摘要。senderUsername / senderIsTeam 一并落库：
 * 昵称会随群昵称与备注变化，username 才是稳定身份（复发识别、同议题合并、时间线我方标记都用它）。
 */
function msgToSummaryMsg(
  m: ChatMessage,
  senderName: string,
  senderIsTeam = false
): FeedbackIssueMsg {
  return {
    time: m.createTime,
    senderName,
    senderUsername: m.senderUsername ?? undefined,
    isSend: m.isSend,
    senderIsTeam: senderIsTeam || undefined,
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
 * 返回该回复的时间（跟进超时计时起点），null = 本回合无我方回复。
 */
function staffReplyAt(msgs: ChatMessage[], idx: number, team: Set<string>): number | null {
  for (let j = idx + 1; j < msgs.length; j++) {
    const x = msgs[j]
    const isStaff = x.isSend || (!!x.senderUsername && team.has(x.senderUsername))
    if (isStaff) return x.createTime
    // 系统消息等非客户对象不影响回合判定；遇到下一条客户消息仍未回复 → 视为未跟进
    if (!x.isSend && !x.senderUsername) continue
    if (!x.isSend) return null
  }
  return null
}

/** 会话语义「已跟进」布尔版（规则聚类用） */
function hasStaffReplyAfter(msgs: ChatMessage[], idx: number, team: Set<string>): boolean {
  return staffReplyAt(msgs, idx, team) !== null
}

/**
 * 议题级「客户静默」判定：客服最后一条回复之后，**本议题的客户**再没说过话，且已静默超阈值。
 * 返回可收尾的时刻（客服最后一条相关消息时间），null = 不可收尾。
 * - 只认本议题客户的发言：群里其他人聊别的不会阻止收尾（否则活跃群永远收不了尾）；
 * - 客户最后发言在我方之后（客户追问没人应）→ 不可收尾，那是「待处理」不是「已闭环」；
 * - 锚点缺发送人身份时退化为保守口径（任何客户发言都算）。
 */
function silentCloseAt(
  msgs: ChatMessage[],
  anchorIdx: number,
  anchorSender: string | undefined,
  team: Set<string>,
  silentMs: number,
  now: number
): number | null {
  if (silentMs <= 0) return null
  let lastStaffIdx = -1
  let lastStaffAt = -1
  let lastCustIdx = -1
  for (let j = anchorIdx + 1; j < msgs.length; j++) {
    const m = msgs[j]
    if (m.isSend || (!!m.senderUsername && team.has(m.senderUsername))) {
      lastStaffIdx = j
      lastStaffAt = m.createTime
      continue
    }
    if (!m.senderUsername) continue
    if (!anchorSender || m.senderUsername === anchorSender) lastCustIdx = j
  }
  if (lastStaffIdx < 0) return null
  if (lastCustIdx > lastStaffIdx) return null
  return now - lastStaffAt >= silentMs ? lastStaffAt : null
}

/** 消息身份（时间+本地序号）：同一毫秒的多条消息不会被时间戳去重误合并 */
function msgIdentity(m: ChatMessage): string {
  return `${m.createTime}:${m.localId}`
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

/** 单页读取条数（增量下要按 sort_seq 兜住迟到写入，页大一些可少翻几次库） */
const READ_PAGE = 200

/**
 * 逐群读取消息（跨库自动分片分页）。
 * @param windowStartMs 时间窗口起点
 * @param stopSeq 水位序号：**只要还有 sort_seq > stopSeq 的行就继续向前翻**。
 *   补录/回拨的旧时间消息（时间没前进但序号前进）也能读进来，不会因「时间早于窗口」被丢。
 *   已读到的行不再按时间过滤：主区/附录由调用方按时间 + 序号共同判定。
 */
interface ReadResult {
  msgs: ChatMessage[]
  /** 是否因单群条数上限截断（时间窗口比实际读取范围更宽）——面板据此提示「未覆盖全窗口」 */
  truncated: boolean
}

function readGroupMessages(
  wxid: string,
  groupUsername: string,
  windowStartMs: number,
  stopSeq?: number
): ReadResult {
  const all: ChatMessage[] = []
  let cursor: Parameters<typeof wxService.getMessages>[3] = undefined
  for (;;) {
    const res = wxService.getMessages(wxid, groupUsername, READ_PAGE, cursor)
    if (!res.ok || !res.messages || res.messages.length === 0) break
    all.unshift(...res.messages) // 返回按序号升序，向后翻更旧页，因此插到头部
    const oldest = res.messages[0]
    // 停止条件：越过时间窗口起点 **且** 已越过水位序号 / 无更旧页 / 已到限容
    const timeDone = oldest.createTime < windowStartMs
    const seqDone = stopSeq === undefined || oldest.sortSeq <= stopSeq
    if (!res.hasMore || !res.nextCursor) break
    if (timeDone && seqDone) break
    if (all.length >= MAX_GROUP_MSGS) break
    cursor = res.nextCursor
  }
  // 限容：超限时保留最新（序号升序 => 截尾部）
  const truncated = all.length > MAX_GROUP_MSGS
  const msgs = truncated ? all.slice(all.length - MAX_GROUP_MSGS) : all
  return { msgs, truncated }
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
      n > 1 ? `${label}：${text0.slice(0, 16)}…（共 ${n} 句）` : `${label}：${text0.slice(0, 24)}`
    const summary =
      n > 1
        ? evidMsgs
            .map((mm) => msgToText(mm))
            .join(' ｜ ')
            .slice(0, 90)
        : text0.slice(0, 80)
    for (const h of c) clusterAnchorTimes.add(h.m.createTime)
    const sevText = c.map((h) => msgToText(h.m)).join(' ')
    const severity: FeedbackIssueSeverity = RULE_SEV_BOOST.some((w) => sevText.includes(w))
      ? '紧急'
      : RULE_SEV_BASE[c[0].type as FeedbackIssueType]
    // 弱命中疑似桶：单句 + 咨询类 + 短文本 + 客服未介入 → 疑似待人工确认（不进正式待办口径）
    const weakConfirm = c.length === 1 && c[0].type === '咨询' && text0.length <= 14 && !replied
    const customerNames = [label].filter((x) => !x.startsWith('我方'))
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
      severity,
      needConfirm: weakConfirm,
      customers: customerNames,
      followUp: replied,
      msgs: evidMsgs.map((mm) => msgToSummaryMsg(mm, senderLabel(mm, team), isTeamMsg(mm, team)))
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
      severity: '一般',
      customers: [senderLabel(tail, team)].filter((x) => !x.startsWith('我方')),
      msgs: [msgToSummaryMsg(tail, senderLabel(tail, team), isTeamMsg(tail, team))]
    })
  }
  return issues
}

/**
 * 主区按「会话段」边界分批：一批 ≤ LLM_CHUNK_ROWS 行。
 * 单批不超 LLM_LINES_CAP → analyzeLlmIssues 内部不再截断；多批时后一批携带前批落库后的 openHints，
 * 跨批的「客户诉求 → 客服回复」仍能被下一批识别闭环，杜绝高活跃群“截断即丢段”。
 */
function chunkMainRows(main: LlmRow[]): LlmRow[][] {
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

/** LLM 输入行解析器：主区行号 < 主区长度；附录行号 ≥ APX_BASE(1000) */
export interface LlmLineRef {
  msg: ChatMessage
  senderName: string
  /** 是否团队客服成员（我方同事） */
  senderIsTeam?: boolean
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
  /** 是否团队客服成员（我方同事） */
  senderIsTeam?: boolean
  text: string
}

function fmtRow(m: ChatMessage, team: Set<string>): LlmRow {
  return {
    msg: m,
    senderName: senderLabel(m, team),
    senderIsTeam: isTeamMsg(m, team) || undefined,
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
 * badExamples：近期被人工判定「不是问题」的样本（抑制同类误报）。
 */
async function analyzeLlmIssues(
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

  const provider = createAiProvider()
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

/** 证据合并上限：超限时保留「最早的 6 条（锚点）+ 最新的 14 条（进展）」 */
const EVIDENCE_CAP = 20

/**
 * 证据合并（key 复用时调用）：按时间升序去重，保住最早锚点行。
 * LLM 的 key 依赖最早证据行，若每轮只写回本轮 evidence，锚点会被覆盖 → 下轮必然再漂移。
 */
function mergeEvidence(
  oldMsgs: FeedbackIssueMsg[],
  newMsgs: FeedbackIssueMsg[]
): FeedbackIssueMsg[] {
  const seen = new Set<string>()
  const all: FeedbackIssueMsg[] = []
  for (const m of [...oldMsgs, ...newMsgs]) {
    const k = `${m.time}|${m.isSend ? 1 : 0}|${m.senderName}|${m.text}`
    if (seen.has(k)) continue
    seen.add(k)
    all.push(m)
  }
  all.sort((a, b) => a.time - b.time)
  if (all.length <= EVIDENCE_CAP) return all
  return [...all.slice(0, 6), ...all.slice(all.length - (EVIDENCE_CAP - 6))]
}

/** 自动闭环回溯上限：锚点早于该时限的问题不再回溯读取，直接视为超期 */
const AUTO_CLOSE_MAX_AGE_MS = 14 * 24 * 3600_000
/** 锚点匹配容差（库时间精度差异） */
const ANCHOR_TOLERANCE_MS = 2000
/** 静默收尾默认阈值（小时）：客服已回复、客户超过该时长再无消息 → 视为自然结束 */
const AUTO_CLOSE_SILENT_HOURS = 72

export interface ReconcileResult {
  /** 判定为跟进中（回合内已回复且未到静默阈值） */
  following: number
  /** 静默收尾自动闭环 */
  closed: number
  /** 超期自动搁置 */
  stalled: number
  /** 实际发生状态写入的条数（供调度器判断是否需要广播刷新） */
  changed: number
}

/**
 * 规则型跟进/收尾判定（确定性，每轮分析对**全部** open 问题执行，不限提取方式）。
 *
 * 为什么不用「LLM 下次又提取到同一议题」来刷新状态：
 * 模型没再提到某议题时跟进标记会永久冻结——跟进超时越算越真、永不消失，
 * 而 LLM 提取的问题也没有任何自动收尾通道（只能人工点）。这里用消息流事实兜住。
 *
 * - 锚点定位：读取窗口内第一个 createTime ≥ occurAt-2s 的消息；锚点早于读取窗口 → 本轮不判定；
 * - 回合内出现我方/团队消息（下一条客户消息之前）→ followUp=1 并记录回复时刻；
 * - 回合内无我方消息 → followUp=0（客户在等回复）；
 * - 静默收尾：已回复 + 本议题客户静默超 monitor.autoCloseHours(默认 72h，0=关闭) → done(auto)；
 * - 锚点早于回溯上限（14 天）仍无法判定 → stalled(auto)（不打扰，也不谎报已回复）。
 * LLM 只负责语义闭环（客户确认/已解决/无需处理）。
 */
function reconcileOpenIssues(
  wxid: string,
  groupUsername: string,
  msgs: ChatMessage[],
  team: Set<string>
): ReconcileResult {
  const out: ReconcileResult = { following: 0, closed: 0, stalled: 0, changed: 0 }
  const pending = listOpenIssuesByGroup(wxid, groupUsername)
  if (pending.length === 0 || msgs.length === 0) return out
  const windowStart = msgs[0].createTime
  const now = Date.now()
  const silentMs = getConfigNumber('monitor.autoCloseHours', AUTO_CLOSE_SILENT_HOURS) * 3600_000
  for (const p of pending) {
    // 锚点早于读取窗口：本轮无从判定（既不谎报已回复，也不误清跟进中）
    if (p.occurAt < windowStart - ANCHOR_TOLERANCE_MS) {
      if (now - p.occurAt > AUTO_CLOSE_MAX_AGE_MS) {
        setIssueStatus(p.id, 'stalled', true)
        out.stalled++
        out.changed++
      }
      continue
    }
    let anchorIdx = -1
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].createTime >= p.occurAt - ANCHOR_TOLERANCE_MS) {
        anchorIdx = i
        break
      }
    }
    if (anchorIdx < 0) continue
    const replyAt = staffReplyAt(msgs, anchorIdx, team)
    if (replyAt === null) {
      if (p.followUp || p.followUpAt !== undefined) {
        setIssueFollowUp(p.id, false)
        out.changed++
      }
      continue
    }
    // 静默收尾：本议题客户在客服回复后再无声音且超过阈值 → 自然结束（auto 标记，可重新打开复核）
    const anchorMsg = msgs[anchorIdx]
    const anchorSender = anchorMsg.isSend ? undefined : (anchorMsg.senderUsername ?? undefined)
    if (silentCloseAt(msgs, anchorIdx, anchorSender, team, silentMs, now) !== null) {
      setIssueStatus(p.id, 'done', true)
      out.closed++
      out.changed++
      continue
    }
    if (!p.followUp || p.followUpAt !== replyAt) {
      setIssueFollowUp(p.id, true, replyAt)
      out.changed++
    }
    out.following++
  }
  return out
}

/**
 * 收尾巡检（零 LLM）：只读消息、只做规则跟进/收尾判定，供后台调度对**有 open 问题的群**周期调用。
 *
 * 为什么必须独立于增量提取：静默收尾的前提恰恰是「群里没有新消息」，
 * 而增量提取在「水位后无新消息」时直接 skip（连消息都不读），永远走不到收尾判定。
 */
export function reconcileGroupFollowups(wxid: string, groupUsername: string): ReconcileResult {
  const empty: ReconcileResult = { following: 0, closed: 0, stalled: 0, changed: 0 }
  if (!wxid || !groupUsername) return empty
  const pending = listOpenIssuesByGroup(wxid, groupUsername)
  if (pending.length === 0) return empty
  const oldestAllowed = Date.now() - AUTO_CLOSE_MAX_AGE_MS
  let readStart = Date.now() - INCR_TAIL_MS
  for (const p of pending) {
    readStart = Math.min(readStart, Math.max(p.occurAt - 1, oldestAllowed))
  }
  readStart = Math.max(readStart, oldestAllowed)
  const { msgs } = readGroupMessages(wxid, groupUsername, readStart)
  if (msgs.length === 0) return empty
  return reconcileOpenIssues(wxid, groupUsername, msgs, getTeamUsernamesCached(wxid))
}

/** 读取某群最近一次分析尝试记录（成功或失败；失败携带 error 供 UI 透传） */
interface GroupStamp {
  at: number
  method?: 'llm' | 'rule'
  count?: number
  error?: string
  coverage?: IssueCoverage
}

function readGroupStamp(wxid: string, groupUsername: string): GroupStamp | null {
  const raw = getConfig(groupStampKey(wxid, groupUsername))
  if (!raw) return null
  try {
    const p = JSON.parse(raw) as {
      at?: number
      method?: string
      count?: number
      error?: string
      coverage?: IssueCoverage
    }
    if (typeof p.at !== 'number') return null
    return {
      at: p.at,
      method: p.method === 'llm' || p.method === 'rule' ? p.method : undefined,
      count: typeof p.count === 'number' ? p.count : undefined,
      error: p.error,
      coverage:
        p.coverage && typeof p.coverage.msgs === 'number'
          ? { msgs: p.coverage.msgs, truncated: !!p.coverage.truncated }
          : undefined
    }
  } catch {
    return null
  }
}

const groupRunKeys = new Map<string, Promise<AnalyzeGroupResult>>()

/** 单群分析覆盖度（面板据此提示「窗口是否被截断」） */
export interface IssueCoverage {
  /** 本次实际读取并参与分析的消息条数 */
  msgs: number
  /** 是否因单群条数上限（MAX_GROUP_MSGS）截断：窗口比实际覆盖范围更宽 */
  truncated: boolean
}

export interface AnalyzeGroupResult {
  ok: boolean
  error?: string
  skipped?: boolean
  method?: 'llm' | 'rule'
  /** 本次**新建**的问题数（既有问题的内容/状态更新不计入） */
  count?: number
  lastAt?: number
  /** 覆盖度（截断时 UI 明示「未覆盖整个窗口」） */
  coverage?: IssueCoverage
  /** 规则判定为跟进中的条数 */
  following?: number
  /** 静默收尾自动闭环的条数 */
  closed?: number
  /** 超期自动搁置的条数 */
  stalled?: number
}

// ── 增量水位（防重复解读/防漏读）──

/** 增量尾巴回看时长：新进展的上下文（结合 INCR_TAIL_ROWS 行数共同生效） */
const INCR_TAIL_MS = 3 * 3600_000
const wmKey = (wxid: string, group: string): string => `issue.wm:${wxid}:${group}`

interface WmValue {
  at: number
  msgTime: number
  /** 已消费最新消息的 sortSeq（防「迟到写入」：时间未前进但序号前进的新消息不被 skip 吞掉） */
  sortSeq?: number
}

function readWm(wxid: string, groupUsername: string): WmValue | null {
  const raw = getConfig(wmKey(wxid, groupUsername))
  if (!raw) return null
  try {
    const p = JSON.parse(raw) as { at?: number; msgTime?: number; sortSeq?: number }
    if (typeof p.at === 'number' && typeof p.msgTime === 'number') {
      return {
        at: p.at,
        msgTime: p.msgTime,
        sortSeq: typeof p.sortSeq === 'number' ? p.sortSeq : undefined
      }
    }
  } catch {
    /* ignore */
  }
  return null
}

/** 保存/推进水位（msgTime 单调推进；sortSeq 取已消费最新一条） */
function saveWm(wxid: string, groupUsername: string, wm: WmValue): void {
  setConfig(
    wmKey(wxid, groupUsername),
    JSON.stringify({ at: wm.at, msgTime: wm.msgTime, sortSeq: wm.sortSeq })
  )
}

/** 清除某群分析状态(水位+节流标记):清空/重算后调用,保证下次进入走全量而不是被旧水位跳过 */
export function clearGroupRunState(wxid: string, groupUsername: string): void {
  setConfig(wmKey(wxid, groupUsername), '')
  setConfig(groupStampKey(wxid, groupUsername), '')
}

/** 群消息库当前最新一条消息（peek 一页；读失败返回 null 表示不拦截） */
function peekLatestRow(
  wxid: string,
  groupUsername: string
): { createTime: number; sortSeq: number } | null {
  try {
    const res = wxService.getMessages(wxid, groupUsername, 80)
    if (!res.ok || !res.messages || res.messages.length === 0) return null
    const newest = res.messages[res.messages.length - 1]
    return { createTime: newest.createTime, sortSeq: newest.sortSeq }
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
      error: stamp.error,
      coverage: stamp.coverage
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
    return {
      ok: true,
      skipped: true,
      method: last?.method,
      count: last?.count,
      lastAt: last?.at,
      coverage: last?.coverage
    }
  }

  const stampNow = (
    at: number,
    extra: { method?: 'llm' | 'rule'; count?: number; error?: string; coverage?: IssueCoverage }
  ): void => {
    setConfig(
      groupStampKey(wxid, groupUsername),
      JSON.stringify({
        at,
        method: extra.method,
        count: extra.count,
        error: extra.error ?? '',
        coverage: extra.coverage
      })
    )
  }

  const run = (async (): Promise<AnalyzeGroupResult> => {
    const startedAt = Date.now()
    // 重算模式下先快照 open 行的人工字段（指派跟进人/疑似已确认），扫描结束后按 key 回填
    let manualSnapshot: ManualFieldSnapshot[] = []
    try {
      // 0) 重算/清空模式:清 open(重置语义)并复位分析状态(水位+节流),再重新提取(历史保留)
      if (reset) {
        manualSnapshot = snapshotOpenManualFields(wxid, groupUsername)
        clearOpenIssuesByGroup(wxid, groupUsername)
        clearGroupRunState(wxid, groupUsername)
      }
      // 1) 水位判定：增量模式且水位后无新消息 → 跳过（不重复解读）。
      //    时间未超水位但 sortSeq 已前进 = 迟到写入（补录/回拨的旧时间消息）：不 skip，
      //    主区按「序号前进 或 时间前进」判定，迟到行照样能被提取；水位按两条线各自单调推进。
      const wm = readWm(wxid, groupUsername)
      let incremental = false
      if (!force && wm) {
        const latest = peekLatestRow(wxid, groupUsername)
        if (latest !== null) {
          const timeNoNew = latest.createTime <= wm.msgTime
          const seqNoNew = wm.sortSeq === undefined || latest.sortSeq <= wm.sortSeq
          if (timeNoNew && seqNoNew) {
            return { ok: true, skipped: true, lastAt: wm.at }
          }
          incremental = true
        } else {
          incremental = true
        }
      }

      // 2) 读取窗口：主分析起点 + 向前扩展（open 议题证据行与其锚点，上限 14 天）
      const today = new Date(startedAt)
      today.setHours(0, 0, 0, 0)
      const base = today.getTime() - (days - 1) * 24 * 3600_000
      const oldestAllowed = Date.now() - AUTO_CLOSE_MAX_AGE_MS
      const openTimes = openIssueEvidenceTimes(wxid, groupUsername)
      // 每个 open 议题的锚点行时间：既用于扩展读取，也用于「附录必须先保住锚点行」
      const openAnchors = openIssueAnchorTimes(wxid, groupUsername)
      let extendMs: number | null = null
      const consider = (t: number): void => {
        const cand = Math.max(t - 1, oldestAllowed)
        if (extendMs === null || cand < extendMs) extendMs = cand
      }
      for (const t of openTimes) consider(t)
      for (const t of openAnchors) consider(t)

      const focusStart = incremental ? wm!.msgTime : base
      // 增量时按序号线判定主区（迟到写入的旧时间行也算主区），非增量时按时间窗判定
      const focusSeq = incremental ? wm!.sortSeq : undefined
      let readStart = incremental ? Math.max(wm!.msgTime - INCR_TAIL_MS, oldestAllowed) : base
      if (extendMs !== null && extendMs < readStart) readStart = extendMs
      readStart = Math.max(readStart, oldestAllowed)

      const read = readGroupMessages(wxid, groupUsername, readStart, focusSeq)
      const msgs = read.msgs
      const coverage: IssueCoverage = { msgs: msgs.length, truncated: read.truncated }
      const team = getTeamUsernamesCached(wxid)
      const provider = createAiProvider()
      if (msgs.length === 0) {
        const method: 'llm' | 'rule' = provider ? 'llm' : 'rule'
        stampNow(Date.now(), { method, count: 0 })
        return { ok: true, method, count: 0, lastAt: Date.now() }
      }
      // 3) 主区/附录划分。附录行有名额上限，必须优先保住「每个 open 议题的锚点行」：
      //    锚点行一旦被挤出上下文，模型就只能为同一议题另起一条(新 key) → 重复待办 + 旧行永不闭环。
      const allRows = buildRows(msgs, team)
      const mainRows: LlmRow[] = []
      const preRows = allRows.filter((r) => r.msg.createTime < focusStart)
      const tailSet = new Set(preRows.slice(-INCR_TAIL_ROWS).map((r) => r.msg.createTime))
      const anchorSet = new Set(openAnchors)
      // 主区 = 序号前进的行（含迟到写入）或时间前进的行；其余进附录候选
      const isMainRow = (r: LlmRow): boolean =>
        focusSeq !== undefined
          ? r.msg.sortSeq > focusSeq || r.msg.createTime >= focusStart
          : r.msg.createTime >= focusStart
      for (const r of allRows) if (isMainRow(r)) mainRows.push(r)
      const apxCandidates = allRows.filter(
        (r) =>
          !isMainRow(r) &&
          (anchorSet.has(r.msg.createTime) ||
            openTimes.has(r.msg.createTime) ||
            tailSet.has(r.msg.createTime))
      )
      const apxRows: LlmRow[] = []
      const apxSeen = new Set<string>()
      const pushApx = (r: LlmRow): void => {
        const id = msgIdentity(r.msg)
        if (apxSeen.has(id)) return
        apxSeen.add(id)
        apxRows.push(r)
      }
      // ① 锚点行优先（超出名额时保最新的锚点：老议题多已超期搁置）
      const anchorRows = apxCandidates.filter((r) => anchorSet.has(r.msg.createTime))
      const keptAnchors =
        anchorRows.length > APX_MAX ? anchorRows.slice(anchorRows.length - APX_MAX) : anchorRows
      keptAnchors.forEach(pushApx)
      // ② 剩余名额给最近的上下文行
      const room = Math.max(0, APX_MAX - apxRows.length)
      if (room > 0) {
        const rest = apxCandidates.filter((r) => !anchorSet.has(r.msg.createTime))
        rest.slice(-room).forEach(pushApx)
      }
      apxRows.sort((a, b) => a.msg.createTime - b.msg.createTime || a.msg.localId - b.msg.localId)
      // 兜底：主区为空（极端窗位）→ 全部当主区处理，避免漏读
      if (mainRows.length === 0 && allRows.length > 0) {
        mainRows.push(...allRows)
        apxRows.length = 0
      }

      // 4) 提取：LLM 按段分批消费（每批落库后再取下一批 openHints；某批失败则该批起
      //    剩余消息用规则补读，避免高活跃群截断丢段，也避免整窗漏提）
      let method: 'llm' | 'rule' = 'rule'
      let n = 0
      /** 客户 username 归并：证据行里非我方、非团队客服的发送人（客户改昵称也能认出同一个人） */
      const deriveCustomerUsernames = (issue: NewIssue): string[] =>
        Array.from(
          new Set(
            issue.msgs
              .map((m) => (m.isSend || m.senderIsTeam ? '' : (m.senderUsername ?? '')))
              .filter((u) => !!u)
          )
        ).slice(0, 6)
      /** 客户身份（昵称 + username）：复发识别与同议题合并都用它匹配 */
      const deriveIdentity = (issue: NewIssue): { customers?: string[]; usernames: string[] } => ({
        customers: deriveCustomers(issue),
        usernames: deriveCustomerUsernames(issue)
      })
      // 议题同一性判据：一次查询取本群现存 open 议题事实，随本轮落库**增量维护**
      // （这样同一轮里后一批/后一个议题也能认出前面刚建的同一议题，防分批重复）
      const topicIndex: OpenTopicRow[] = openTopicIndex(wxid, groupUsername)
      const rowFacts = (r: OpenTopicRow): TopicFacts => ({
        title: r.title,
        type: r.type,
        customers: r.customers,
        usernames: r.usernames,
        evidenceTimes: r.evidenceTimes,
        occurAt: r.occurAt
      })
      const issueFacts = (
        it: NewIssue,
        identity: { customers?: string[]; usernames: string[] }
      ): TopicFacts => ({
        title: it.title,
        type: it.type,
        customers: identity.customers,
        usernames: identity.usernames,
        evidenceTimes: Array.from(new Set(it.msgs.map((m) => m.time))),
        occurAt: it.occurAt
      })
      /** 本轮新建的行 id：对它们禁用「时间邻近」判据（模型刚在同一批输入里主动拆成两条，不该按时间并回去） */
      const createdThisRun = new Set<number>()
      /** 在现存/本轮已建的 open 议题里找同一条（标题 / 证据重叠 / 同客户+同类型+时间邻近 三组判据） */
      const matchExisting = (
        it: NewIssue,
        identity: { customers?: string[]; usernames: string[] }
      ): OpenTopicRow | undefined => {
        const facts = issueFacts(it, identity)
        for (const row of topicIndex) {
          const unreplied = it.key.includes(':unreplied:') || row.key.includes(':unreplied:')
          // 未回复留言是「同一件没人处理的事」，时间窗放宽到 72h；
          // 本轮刚建的行走 0（跳过时间判据），只认标题/证据这类更强信号
          const gap = createdThisRun.has(row.id) ? 0 : unreplied ? UNREPLIED_MERGE_MS : undefined
          if (topicSame(facts, rowFacts(row), { maxTimeGapMs: gap }).same) return row
        }
        return undefined
      }
      /** 客户身份回退：从证据行取非我方发送人昵称（LLM/规则均可能缺 customers） */
      const deriveCustomers = (issue: NewIssue): string[] | undefined => {
        if (issue.customers && issue.customers.length > 0) return issue.customers
        const names = Array.from(
          new Set(
            issue.msgs
              .map((m) => m.senderName)
              .filter((x) => !!x && !x.startsWith('我方'))
              .map((x) => x.trim())
              .filter(Boolean)
          )
        ).slice(0, 4)
        return names.length > 0 ? names : undefined
      }
      // 整批包一个事务:每个 issue 内部是「1 条 update + 1 条 delete + k 条 insert」,
      // 逐条自动提交在 WAL 下慢一个数量级,中途异常还会留下删了一半的中间态
      const applyExtracted = (list: NewIssue[]): void => {
        const tx = getDb().transaction(() => {
          for (const issue of list) {
            if (issue.resolved) {
              let existing = findIssueByKey(issue.key)
              if (!existing) {
                // key 漂移兜底：模型判定已闭环，但锚点行变了 → 按同一性判据找到真正的旧行并闭环
                const target = matchExisting(issue, deriveIdentity(issue))
                if (target) existing = findIssueByKey(target.key)
              }
              if (existing && existing.status === 'open') {
                setIssueStatus(existing.id, 'done', true)
              }
              continue
            }
            const customers = deriveCustomers(issue)
            issue.customers = customers
            const identity = deriveIdentity(issue)
            // 同 key 既有行；找不到再按同一性判据复用其 key（防锚点漂移重复建行）
            let prev = findIssueByKey(issue.key)
            if (!prev) {
              const target = matchExisting(issue, identity)
              if (target) {
                issue.key = target.key
                prev = findIssueByKey(target.key)
              }
            }
            if (prev) {
              // 既有行：保留最早发生时间与既有证据（LLM key 依赖最早证据行，证据被覆盖会导致下轮再漂移）
              issue.occurAt = Math.min(issue.occurAt, prev.occurAt)
              if (prev.status === 'open') {
                issue.msgs = mergeEvidence(getIssueMsgs(prev.id), issue.msgs)
              }
            } else {
              // 复发识别：仅对全新行判定（同 key 已存在 = 同一轮/历史行，不重复计数）
              const cand = findReopenCandidate(
                wxid,
                groupUsername,
                issue.type,
                identity,
                issue.occurAt
              )
              if (cand) {
                issue.reopenCount = cand.reopenCount + 1
                issue.reopenedFrom = cand.id
              }
            }
            // 计数口径 = 真正新建的行（既有行的内容/状态更新不算「新问题」，
            // 否则提示音、桌面通知与飞书「新问题」推送会把老问题的更新当新问题播报）
            const res = upsertIssue(issue)
            if (res.created) {
              n++
              createdThisRun.add(res.id)
            }
            // 增量维护判据索引（含证据/标题的最新值），供本轮后续议题与批次比对
            const nextRow: OpenTopicRow = {
              id: res.id,
              key: issue.key,
              type: issue.type,
              method: issue.method,
              title: issue.title,
              occurAt: issue.occurAt,
              customers: issue.customers,
              usernames: deriveCustomerUsernames(issue),
              evidenceTimes: Array.from(new Set(issue.msgs.map((m) => m.time)))
            }
            const at = topicIndex.findIndex((t) => t.key === issue.key)
            if (at >= 0) topicIndex[at] = nextRow
            else topicIndex.push(nextRow)
          }
        })
        tx()
      }
      const llmBadExamples = (): string[] => recentRejectedSamples(wxid, groupUsername, 3)
      if (provider && mainRows.length > 0) {
        method = 'llm'
        // 最后成功消费的主区行（消息对象锚点），失败补读时据此切“剩余消息”
        let consumed: ChatMessage | null = null
        const chunks = chunkMainRows(mainRows)
        for (let ci = 0; ci < chunks.length; ci++) {
          const chunk = chunks[ci]
          try {
            const openNow = openIssuesForGroup(wxid, groupUsername, 6)
            const openHints = openNow.map(
              (i) =>
                `[${i.type}${i.severity && i.severity !== '一般' ? `·${i.severity}` : ''}] ${i.title}${
                  i.followUp ? '（跟进中）' : ''
                } · 首现 ${new Date(i.occurAt).toLocaleString('zh-CN', { hour12: false })}`
            )
            const out = await analyzeLlmIssues(
              wxid,
              groupUsername,
              groupName,
              chunk,
              apxRows,
              openHints,
              llmBadExamples(),
              openNow.map((i) => i.key)
            )
            applyExtracted(out)
            consumed = chunk[chunk.length - 1].msg
          } catch {
            // 已成功批保留；成功边界之后的消息用规则补读（避免与 LLM 行重复建）
            const rest =
              consumed !== null ? msgs.slice(msgs.findIndex((m) => m === consumed) + 1) : msgs
            if (rest.length > 0) {
              applyExtracted(fallbackRuleIssues(wxid, groupUsername, groupName, rest, team))
            }
            break
          }
        }
      } else if (msgs.length > 0) {
        applyExtracted(fallbackRuleIssues(wxid, groupUsername, groupName, msgs, team))
      }

      // 4b) 重算模式：回填人工字段（指派跟进人/疑似确认），重算不该悄悄清掉人的操作
      if (manualSnapshot.length > 0) restoreManualFields(manualSnapshot)

      // 5) 规则跟进/收尾判定（全部 open 问题：跟进中 → 静默收尾 → 超期搁置）
      const rec = reconcileOpenIssues(wxid, groupUsername, msgs, team)

      // 6) 成功推进水位（时间与序号各自单调推进；失败不推进，下次自动补读）
      const prevWm = readWm(wxid, groupUsername)
      const maxCreateTime = msgs.reduce((m, x) => (x.createTime > m ? x.createTime : m), 0)
      const newestRow = msgs[msgs.length - 1]
      const nextMsgTime = Math.max(maxCreateTime, prevWm?.msgTime ?? 0)
      const nextSeq = Math.max(newestRow.sortSeq, prevWm?.sortSeq ?? -1)
      if (!prevWm || nextMsgTime > prevWm.msgTime || nextSeq > (prevWm.sortSeq ?? -1)) {
        saveWm(wxid, groupUsername, { at: Date.now(), msgTime: nextMsgTime, sortSeq: nextSeq })
      }
      stampNow(Date.now(), { method, count: n, coverage })
      return {
        ok: true,
        method,
        count: n,
        lastAt: Date.now(),
        coverage,
        following: rec.following,
        closed: rec.closed,
        stalled: rec.stalled
      }
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

// ── 全量重析的进度与取消（30 个群串行跑可能几分钟，没进度/不能停体验很差）──

export interface IssueProgress {
  wxid: string
  phase: 'group' | 'done' | 'cancelled'
  done: number
  total: number
  /** 当前处理的群名（phase=group 时有值） */
  current?: string
}

type IssueProgressSink = (p: IssueProgress) => void
let progressSink: IssueProgressSink | null = null

/** 注入进度出口（IPC 层注册 → 渲染端 cs:issue:progress）；传 null 取消注册 */
export function setIssueProgressSink(fn: IssueProgressSink | null): void {
  progressSink = fn
}

/** 已请求取消的账号（按群边界停下：当前群跑完即中止，已产出的结果保留） */
const cancelRequested = new Set<string>()

/** 请求取消该账号正在跑的全量重析 */
export function cancelIssuesAnalysis(wxid: string): void {
  if (wxid) cancelRequested.add(wxid)
}

/** 分析并写库（带 in-flight 保护，按账号串行） */
const runningWxids = new Map<string, Promise<void>>()
/** 成功态（含 lastAt）配置键 */
const stateConfigKey = (wxid: string): string => `issue.analyzed:${wxid}`
/** 失败标记配置键：失败不写 lastAt，仅标记，避免每次进入都重复自动全量扫描 */
const failConfigKey = (wxid: string): string => `issue.analyzeFail:${wxid}`

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

    const candidates = sessionsRes.sessions
      .filter(
        (s) =>
          s.isGroup && !s.isWeCom && s.lastTimestamp >= windowStart && s.displayName.trim() !== ''
      )
      .sort((a, b) => b.lastTimestamp - a.lastTimestamp)
    const groups = candidates.slice(0, MAX_GROUPS)
    // 覆盖度透明：活跃群超过上限时只扫前 N 个，UI 明示，不再静默截断
    const capped = candidates.length > groups.length

    let upserted = 0
    let scanned = 0
    let cancelled = false
    cancelRequested.delete(wxid)
    progressSink?.({ wxid, phase: 'group', done: 0, total: groups.length })
    // 逐群走 analyzeGroupIssues（force）：统一按群锁、自动闭环，避免与工作台单群分析并发撞车
    for (const g of groups) {
      if (cancelRequested.has(wxid)) {
        cancelled = true
        break
      }
      const r = await analyzeGroupIssues(wxid, g.username, g.displayName, {
        days: WINDOW_DAYS,
        force: true
      })
      if (r.ok && r.count) upserted += r.count
      scanned += 1
      progressSink?.({
        wxid,
        phase: 'group',
        done: scanned,
        total: groups.length,
        current: g.displayName
      })
    }
    cancelRequested.delete(wxid)
    progressSink?.({
      wxid,
      phase: cancelled ? 'cancelled' : 'done',
      done: scanned,
      total: groups.length
    })

    const payload = {
      at: Date.now(),
      method,
      count: upserted,
      groups: scanned,
      groupsTotal: groups.length,
      capped,
      cancelled
    }
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

/** 该群是否已有增量水位（后台调度只对已建水位的群做增量；未扫过的群由「打开群/手动」首次全量，避免冷启动风暴） */
export function hasGroupWatermark(wxid: string, groupUsername: string): boolean {
  return readWm(wxid, groupUsername) !== null
}

/** 读取最近一次分析记录（app_config 持久化；失败标记会随 state.error 返回） */
export function readState(wxid: string): FeedbackAnalysisState {
  const state: FeedbackAnalysisState = { running: runningWxids.has(wxid), wxid }
  const raw = getConfig(stateConfigKey(wxid))
  if (raw) {
    try {
      const p = JSON.parse(raw) as {
        at?: number
        method?: string
        groups?: number
        groupsTotal?: number
        capped?: boolean
        cancelled?: boolean
      }
      if (p.method === 'llm' || p.method === 'rule') state.method = p.method
      if (typeof p.at === 'number') state.lastAt = p.at
      if (typeof p.groups === 'number') state.groups = p.groups
      if (typeof p.groupsTotal === 'number') state.groupsTotal = p.groupsTotal
      if (p.capped) state.groupsCapped = true
      if (p.cancelled) state.cancelled = true
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

// ── 存量去重：合并历史锚点漂移留下的重复议题 ──

export interface DuplicateMergePlanItem {
  /** 保留的议题 id（组内最早发生的一条） */
  keepId: number
  keepTitle: string
  /** 归档为「重复」的议题 id 与其标题 */
  dropIds: number[]
  dropTitles: string[]
  groupName: string
  /** 判定理由（人工复核用） */
  reasons: string[]
  /** 高置信（强信号连通）：开启自动合并后由后台直接处理 */
  strong: boolean
  /** 本可自动合并、但组内存在多个不同跟进人 → 留给人工决定归属 */
  skippedAuto?: boolean
}

export interface DuplicateMergeResult {
  /** 重复组数 */
  clusters: number
  /** 被归档的重复行数 */
  merged: number
  plan: DuplicateMergePlanItem[]
}

/**
 * 存量去重：把历史上因锚点漂移产生的重复议题合并回一条。
 * - 判据与实时合并完全一致（issueSimilarity.topicSame），因此清理之后新提取不会再生成同类重复；
 * - 每组保留最早发生的一条：合并证据（去重后按时间排序、限容）、取最高严重度、并集客户、沿用指派跟进人；
 * - 其余归档为「重复」(archived_from='duplicate')——不计入闭环率/趋势，也不作为 LLM 反例样本；
 * - dryRun=true 只返回方案供 UI 预览确认，不写库。
 */
export function mergeDuplicateIssues(
  wxid: string,
  opts: {
    dryRun?: boolean
    /** 只处理高置信组（后台自动合并用：弱信号一律留给人工在监控页预览确认） */
    strongOnly?: boolean
  } = {}
): DuplicateMergeResult {
  const result: DuplicateMergeResult = { clusters: 0, merged: 0, plan: [] }
  if (!wxid) return result
  const open = listIssues(wxid, { status: 'open' })
  if (open.length < 2) return result
  const byGroup = new Map<string, FeedbackIssue[]>()
  for (const it of open) {
    const arr = byGroup.get(it.groupUsername)
    if (arr) arr.push(it)
    else byGroup.set(it.groupUsername, [it])
  }
  for (const [group, list] of byGroup) {
    if (list.length < 2) continue
    const idx = new Map(openTopicIndex(wxid, group).map((r) => [r.id, r]))
    const rows = list.map((it) => {
      const facts = idx.get(it.id)
      return {
        id: it.id,
        key: it.key,
        title: it.title,
        type: it.type,
        occurAt: it.occurAt,
        customers: it.customers,
        usernames: facts?.usernames ?? [],
        evidenceTimes: facts?.evidenceTimes ?? [],
        ref: it
      }
    })
    const clusters = clusterTopics(rows, {
      timeGapFor: (x, y) =>
        x.key.includes(':unreplied:') || y.key.includes(':unreplied:')
          ? UNREPLIED_MERGE_MS
          : TOPIC_TIME_NEAR_MS
    })
    for (const c of clusters) {
      const members = c.members
      const keep = members.reduce((x, y) =>
        y.occurAt < x.occurAt || (y.occurAt === x.occurAt && y.id < x.id) ? y : x
      )
      const drops = members.filter((m) => m.id !== keep.id)
      // 自动合并的安全阀：组内若有多个不同跟进人，归属需要人来定，不自动并
      const assignees = new Set(members.map((m) => m.ref.assignee).filter((x) => !!x))
      const autoSafe = c.strong && assignees.size <= 1
      if (opts.strongOnly && !autoSafe) continue
      result.plan.push({
        keepId: keep.id,
        keepTitle: keep.title,
        dropIds: drops.map((d) => d.id),
        dropTitles: drops.map((d) => d.title),
        groupName: keep.ref.groupName || group,
        reasons: c.reasons,
        strong: c.strong,
        skippedAuto: c.strong && assignees.size > 1
      })
      result.merged += drops.length
      if (opts.dryRun) continue
      // 表达用字段：规则提取的标题是原文摘录，同组里有 LLM 概括时优先用它
      const llm = members
        .filter((m) => m.ref.method === 'llm')
        .sort((x, y) => x.occurAt - y.occurAt)[0]
      const src = keep.ref.method === 'rule' && llm ? llm.ref : keep.ref
      const severity: FeedbackIssueSeverity = members.some((m) => m.ref.severity === '紧急')
        ? '紧急'
        : members.some((m) => m.ref.severity === '高')
          ? '高'
          : (keep.ref.severity ?? '一般')
      const customers = Array.from(
        new Set(
          members
            .flatMap((m) => m.ref.customers ?? [])
            .map((x) => x.trim())
            .filter(Boolean)
        )
      ).slice(0, 6)
      applyIssueMerge({
        id: keep.id,
        title: src.title,
        summary: src.summary,
        type: src.type,
        severity,
        customers: customers.length > 0 ? customers : undefined,
        occurAt: members.reduce((mn, m) => Math.min(mn, m.occurAt), keep.occurAt),
        // 疑似口径取「有人确认过就算已确认」：合并本身不该把议题重新丢回疑似桶
        needConfirm: members.some((m) => !m.ref.needConfirm) ? 0 : 1,
        assignee: members.map((m) => m.ref.assignee).find((x) => !!x) ?? null,
        reopenCount: members.reduce((mx, m) => Math.max(mx, m.ref.reopenCount ?? 0), 0),
        msgs: mergeEvidence(
          [],
          members.flatMap((m) => getIssueMsgs(m.id))
        )
      })
      archiveDuplicates(drops.map((d) => d.id))
    }
  }
  result.clusters = result.plan.length
  return result
}

export function updateIssueStatus(id: number, status: FeedbackIssueStatus): void {
  setIssueStatus(id, status)
}

/** 清空某账号的问题数据并复位分析/失败标记与各群水位/节流（下次自动分析从真实群消息全量重新提取） */
export function clearFeedbackIssues(wxid: string): void {
  // 先收集该账号出现过的群,逐一清除增量水位与节流标记,避免清空后被旧水位跳过
  const groups = new Set(listIssues(wxid).map((i) => i.groupUsername))
  clearIssues(wxid)
  setConfig(stateConfigKey(wxid), '')
  setConfig(failConfigKey(wxid), '')
  for (const g of groups) clearGroupRunState(wxid, g)
}
