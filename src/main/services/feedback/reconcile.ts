/**
 * 规则型跟进/收尾判定（确定性）：跟进中 / 待处理 / 静默收尾 / 超期搁置。
 * 与 LLM 的分工：规则管「有没有人应过」，LLM 管「议题是否真的闭环」。
 */
import { getConfigNumber } from '../../db/repos/config'
import { listOpenIssuesByGroup, setIssueFollowUp, setIssueStatus } from '../../db/repos/issueRepo'
import { getTeamUsernamesCached } from '../../db/repos/teamRepo'
import type { ChatMessage } from '../../../shared/types'
import {
  attributeStaffReplies,
  lastCustomerMessageAt,
  replyForAnchor,
  type StaffReply
} from './replyAttribution'
import { INCR_TAIL_MS, readGroupMessages } from './shared'

/** 自动闭环回溯上限：锚点早于该时限的问题不再回溯读取，直接视为超期 */
export const AUTO_CLOSE_MAX_AGE_MS = 14 * 24 * 3600_000

/** 锚点匹配容差（库时间精度差异） */
export const ANCHOR_TOLERANCE_MS = 2000

/** 静默收尾默认阈值（小时）：客服已回复、客户超过该时长再无消息 → 视为自然结束 */
export const AUTO_CLOSE_SILENT_HOURS = 72

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
 * 议题级「客户静默」判定：本议题客户的最后一条回复之后，该客户再没说过话，且已静默超阈值。
 * 返回可收尾的时刻（该客户最后一条被我方回复的时间），null = 不可收尾。
 * - 只认「归属到本议题客户」的回复：群里其他人聊别的既不阻止收尾，也不算这条议题的跟进；
 * - 客户最后发言晚于该回复（客户追问没人应）→ 不可收尾，那是「待处理」不是「已闭环」；
 * - 锚点缺发送人身份（例如模型把一条系统/我方消息当最早证据）→ 不做静默收尾，留给人工。
 */
export function silentCloseAt(
  replies: Map<string, StaffReply>,
  msgs: ChatMessage[],
  anchor: { at: number; sender?: string },
  silentMs: number,
  now: number
): number | null {
  if (silentMs <= 0 || !anchor.sender) return null
  const reply = replyForAnchor(replies, anchor.sender, anchor.at)
  if (!reply) return null
  const lastCustAt = lastCustomerMessageAt(msgs, anchor.at, anchor.sender)
  if (lastCustAt > reply.at) return null
  return now - reply.at >= silentMs ? reply.at : null
}

/**
 * 规则型跟进/收尾判定（确定性，每轮分析对**全部** open 问题执行，不限提取方式）。
 *
 * 为什么不用「LLM 下次又提取到同一议题」来刷新状态：
 * 模型没再提到某议题时跟进标记会永久冻结——跟进超时越算越真、永不消失，
 * 而 LLM 提取的问题也没有任何自动收尾通道（只能人工点）。这里用消息流事实兜住。
 *
 * - 锚点定位：读取窗口内第一个 createTime ≥ occurAt-2s 的消息；锚点早于读取窗口 → 本轮不判定；
 * - 回复判定用**归属**而非回合（见 replyAttribution）：每条我方/团队消息归属给最近一条客户消息的发送人，
 *   只认「本议题客户名下、且不早于锚点」的回复 → followUp=1 并记录回复时刻与回复人；
 *   客户连发多条（补图/追问/@客服）后再回复也能正确识别（旧回合规则会漏掉，实测 issue 82）；
 * - 锚点本身就是我方消息（模型把客服回复当最早证据）→ 这条议题已在处理中，直接 followUp=1；
 * - 无归属回复 → followUp=0（客户在等回复）；
 * - 静默收尾：已回复 + 本议题客户静默超 monitor.autoCloseHours(默认 72h，0=关闭) → done(auto)；
 * - 锚点早于回溯上限（14 天）仍无法判定 → stalled(auto)（不打扰，也不谎报已回复）。
 * LLM 只负责语义闭环（客户确认/已解决/无需处理）。
 */
export function reconcileOpenIssues(
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
  // 全窗口一次扫描出「客户 → 最后一条被回复」的归属表（同群多议题共用，避免逐条重复扫）
  const replies = attributeStaffReplies(msgs, team)
  for (const p of pending) {
    // 首现时间脏数据（NULL/NaN）：锚点未知，本轮直接跳过。
    // 否则下面两个判断都会命中（null 与数字比较恒真、now-null 恒大于上限）→ 议题被误自动搁置。
    if (!Number.isFinite(Number(p.occurAt))) continue
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
    const anchorMsg = msgs[anchorIdx]
    const anchorIsStaff =
      anchorMsg.isSend || (!!anchorMsg.senderUsername && team.has(anchorMsg.senderUsername))
    const anchorSender = anchorIsStaff ? undefined : (anchorMsg.senderUsername ?? undefined)
    // 锚点本身就是我方/团队消息（模型把客服回复当成了最早证据）→ 这条议题已经在被处理
    if (anchorIsStaff) {
      if (!p.followUp || p.followUpAt !== anchorMsg.createTime) {
        setIssueFollowUp(p.id, true, anchorMsg.createTime)
        out.changed++
      }
      out.following++
      continue
    }
    const reply = replyForAnchor(replies, anchorSender, anchorMsg.createTime)
    if (reply === null) {
      if (p.followUp || p.followUpAt !== undefined || p.lastReplyBy !== undefined) {
        setIssueFollowUp(p.id, false)
        out.changed++
      }
      continue
    }
    // 静默收尾：本议题客户在该回复后再无声音且超过阈值 → 自然结束（auto 标记，可重新打开复核）
    const closeAt = silentCloseAt(
      replies,
      msgs,
      { at: anchorMsg.createTime, sender: anchorSender },
      silentMs,
      now
    )
    if (closeAt !== null) {
      setIssueStatus(p.id, 'done', true)
      out.closed++
      out.changed++
      continue
    }
    if (!p.followUp || p.followUpAt !== reply.at || p.lastReplyBy !== reply.by) {
      setIssueFollowUp(p.id, true, reply.at, reply.by)
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
  // 规则判定只用 senderUsername/isSend/时间，用不到昵称头像 → 跳过 enrich
  const { msgs } = readGroupMessages(wxid, groupUsername, readStart, undefined, { enrich: false })
  if (msgs.length === 0) return empty
  return reconcileOpenIssues(wxid, groupUsername, msgs, getTeamUsernamesCached(wxid))
}
