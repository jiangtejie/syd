/**
 * 规则型跟进/收尾判定（确定性）：跟进中 / 待处理 / 静默收尾 / 超期搁置。
 * 与 LLM 的分工：规则管「有没有人应过」，LLM 管「议题是否真的闭环」。
 */
import { getConfigNumber } from '../../db/repos/config'
import { listOpenIssuesByGroup, setIssueFollowUp, setIssueStatus } from '../../db/repos/issueRepo'
import { getTeamUsernamesCached } from '../../db/repos/teamRepo'
import type { ChatMessage } from '../../../shared/types'
import { INCR_TAIL_MS, readGroupMessages, staffReplyAt } from './shared'

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
 * 议题级「客户静默」判定：客服最后一条回复之后，**本议题的客户**再没说过话，且已静默超阈值。
 * 返回可收尾的时刻（客服最后一条相关消息时间），null = 不可收尾。
 * - 只认本议题客户的发言：群里其他人聊别的不会阻止收尾（否则活跃群永远收不了尾）；
 * - 客户最后发言在我方之后（客户追问没人应）→ 不可收尾，那是「待处理」不是「已闭环」；
 * - 锚点缺发送人身份时退化为保守口径（任何客户发言都算）。
 */
export function silentCloseAt(
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
    const reply = staffReplyAt(msgs, anchorIdx, team)
    if (reply === null) {
      if (p.followUp || p.followUpAt !== undefined || p.lastReplyBy !== undefined) {
        setIssueFollowUp(p.id, false)
        out.changed++
      }
      continue
    }
    const replyAt = reply.at
    // 静默收尾：本议题客户在客服回复后再无声音且超过阈值 → 自然结束（auto 标记，可重新打开复核）
    const anchorMsg = msgs[anchorIdx]
    const anchorSender = anchorMsg.isSend ? undefined : (anchorMsg.senderUsername ?? undefined)
    if (silentCloseAt(msgs, anchorIdx, anchorSender, team, silentMs, now) !== null) {
      setIssueStatus(p.id, 'done', true)
      out.closed++
      out.changed++
      continue
    }
    if (!p.followUp || p.followUpAt !== replyAt || p.lastReplyBy !== reply.by) {
      setIssueFollowUp(p.id, true, replyAt, reply.by)
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
