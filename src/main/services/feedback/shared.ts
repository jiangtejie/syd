/**
 * 群问题分析：消息/文本层公共基础（原 analyzer.ts 拆出）。
 * 这里只放**被两个以上阶段共用**的东西：消息→文本、发送人标签、回合内我方回复判定、
 * 证据合并、会话分段、以及跨库读取窗口。分析主流程见 analyzer.ts，各阶段见
 * ruleExtract / llmExtract / reconcile / duplicates。
 */
import * as wxService from '../wechat/wxService'
import type {
  ChatMessage,
  FeedbackIssueMsg,
  FeedbackIssueSeverity,
  FeedbackIssueType
} from '../../../shared/types'
import { fmtHms } from '../../../shared/monitorMetrics'

export const ISSUE_TYPES: FeedbackIssueType[] = [
  '客诉',
  '售后',
  '物流',
  '价格',
  '咨询',
  '建议',
  '其他'
]

/** 严重度归一（收敛 LLM/规则输出；脏值回落 一般） */
export function normalizeSeverity(s: string | null | undefined): FeedbackIssueSeverity {
  return s === '紧急' || s === '高' ? s : '一般'
}

/** 收敛 LLM 输出类型到枚举 */
export function normalizeType(t: string | undefined | null): FeedbackIssueType {
  const hit = ISSUE_TYPES.find((x) => x === t)
  if (hit) return hit
  const fuzzy = ISSUE_TYPES.find((x) => t?.includes(x))
  return fuzzy ?? '其他'
}

/** 单条消息转人类可读文本（供 LLM 上下文与规则匹配） */
export function msgToText(m: ChatMessage): string {
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
export function isTeamMsg(m: ChatMessage, team: Set<string>): boolean {
  return !m.isSend && !!m.senderUsername && team.has(m.senderUsername)
}

/**
 * 证据行摘要。senderUsername / senderIsTeam 一并落库：
 * 昵称会随群昵称与备注变化，username 才是稳定身份（复发识别、同议题合并、时间线我方标记都用它）。
 */
export function msgToSummaryMsg(
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
export function senderLabel(m: ChatMessage, team?: Set<string>): string {
  if (m.isSend) return '我方客服'
  const u = m.senderUsername
  if (team && u && team.has(u)) {
    const nick = m.senderNickname || u
    return nick === u ? '我方同事' : `我方同事（${nick}）`
  }
  return m.senderNickname || u || '客户'
}

/** LLM 上下文行消息过滤（真文本 + 带摘要的 appmsg + 图片） */
export function isTextLike(m: ChatMessage): boolean {
  return m.localType === 1 || m.localType === 49
}

/** 规则模式只吃真文本（type 1）；49 型摘要（[链接]/[文件]/[聊天记录]/[转账]）会引入假关键词，不参与匹配 */
export function isRuleText(m: ChatMessage): boolean {
  return m.localType === 1
}

/** 消息身份（时间+本地序号）：同一毫秒的多条消息不会被时间戳去重误合并 */
export function msgIdentity(m: ChatMessage): string {
  return `${m.createTime}:${m.localId}`
}

/**
 * 证据合并（key 复用时调用）：按时间升序去重，保住最早锚点行。
 * LLM 的 key 依赖最早证据行，若每轮只写回本轮 evidence，锚点会被覆盖 → 下轮必然再漂移。
 */
export function mergeEvidence(
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

/** 证据合并上限：超限时保留「最早的 6 条（锚点）+ 最新的 14 条（进展）」 */
export const EVIDENCE_CAP = 20

/** 会话段切分：消息间隔 ≥ 该值视为新一段（沉默分隔话题） */
export const SEGMENT_GAP_MS = 15 * 60_000

/** 输入行（过滤后）按时间切段，供 LLM 以「段」为单位整体理解 */
export function segmentizeLines(
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

export interface LlmRow {
  msg: ChatMessage
  senderName: string
  /** 是否团队客服成员（我方同事） */
  senderIsTeam?: boolean
  text: string
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

export function fmtRow(m: ChatMessage, team: Set<string>): LlmRow {
  return {
    msg: m,
    senderName: senderLabel(m, team),
    senderIsTeam: isTeamMsg(m, team) || undefined,
    text: `${fmtHms(m.createTime)} ${senderLabel(m, team)}: ${msgToText(m)}`
  }
}

/** 单群扫描消息上限（窗口内消息超限时保留最新） */
export const MAX_GROUP_MSGS = 800

/** 单页读取条数（增量下要按 sort_seq 兜住迟到写入，页大一些可少翻几次库） */
export const READ_PAGE = 200

/**
 * 逐群读取消息（跨库自动分片分页）。
 * @param windowStartMs 时间窗口起点
 * @param stopSeq 水位序号：**只要还有 sort_seq > stopSeq 的行就继续向前翻**。
 *   补录/回拨的旧时间消息（时间没前进但序号前进）也能读进来，不会因「时间早于窗口」被丢。
 *   已读到的行不再按时间过滤：主区/附录由调用方按时间 + 序号共同判定。
 */
export interface ReadResult {
  msgs: ChatMessage[]
  /** 是否因单群条数上限截断（时间窗口比实际读取范围更宽）——面板据此提示「未覆盖全窗口」 */
  truncated: boolean
}

export function readGroupMessages(
  wxid: string,
  groupUsername: string,
  windowStartMs: number,
  stopSeq?: number,
  opts: {
    /** 只做规则判定（跟进/收尾）时用不到昵称头像 → 跳过联系库 enrich，省一次开库 */
    enrich?: boolean
  } = {}
): ReadResult {
  const all: ChatMessage[] = []
  let cursor: Parameters<typeof wxService.getMessages>[3] = undefined
  for (;;) {
    // skipEnrich：每页 enrich 都要开一次联系人库，多页就是多次开库；
    // 读完整窗后在下面统一补一次发送人昵称即可（群昵称/头像与分页无关）
    const res = wxService.getMessages(wxid, groupUsername, READ_PAGE, cursor, true)
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
  // 统一补发送人昵称/团队标记：一次开联系人库，替代「每页 enrich 一次」；
  // 只做规则判定的调用方可以直接跳过（判定只看 senderUsername/isSend/时间）
  if (opts.enrich === false) return { msgs, truncated }
  return { msgs: wxService.enrichMessages(wxid, groupUsername, msgs), truncated }
}

/** 「客户留言未回复」议题的合并窗：同一客户跨天重复留言仍视为同一件事在等回复 */
export const UNREPLIED_MERGE_MS = 72 * 3600_000

/** 增量尾巴回看时长：新进展的上下文（结合 INCR_TAIL_ROWS 行数共同生效） */
export const INCR_TAIL_MS = 3 * 3600_000
