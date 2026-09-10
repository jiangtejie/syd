import type { ChatMessage } from '../../../shared/types'

/**
 * 我方/团队回复的「归属」判定（纯函数，无 IO，便于回归自检）。
 *
 * 为什么需要它：跟进状态要回答的是「这条议题的客户，有没有人应过」。
 * 旧规则是「锚点之后遇到下一条客户消息就结束回合」—— 但客户连发几句（补图、追问、@客服）极其常见：
 *
 *   14:04:03 客户：这个单子还没收到？      ← 议题锚点
 *   14:04:03 客户：[图片]
 *   14:04:53 客户：@亚特物配文员
 *   14:05:18 我方同事：YHSQ00... 颜总，您...
 *
 * 旧规则在第二条客户消息处就判定「回合结束、无人回复」，客服的回复被完全忽略，
 * 状态长期停在「待处理」（实测 issue 82 正是如此）。
 *
 * 现在的做法：把每条我方/团队消息归属给**最近一条客户消息的发送人**，再按客户维度取最后回复。
 * 既解决「客户连发多条」，又能避免「群里另一位客户被回复」被算成本议题的回复。
 */

export interface StaffReply {
  /** 回复时间（毫秒） */
  at: number
  /** 团队客服 username；我本人回复时为 undefined */
  by?: string
}

/**
 * 全窗口扫描一次，得到「客户 username → 其最后一条被回复的时间/回复人」。
 * 我本人（isSend）的消息同样按归属记录，只是没有 by。
 */
export function attributeStaffReplies(
  msgs: ChatMessage[],
  team: Set<string>
): Map<string, StaffReply> {
  const out = new Map<string, StaffReply>()
  let lastCustomer: string | undefined
  for (const m of msgs) {
    if (m.isSend) {
      // 我本人发言：归属给最近一位说话的客户（无 by）
      if (lastCustomer) out.set(lastCustomer, { at: m.createTime })
      continue
    }
    const u = m.senderUsername
    if (!u) continue // 系统/无发送人：不影响归属
    if (team.has(u)) {
      if (lastCustomer) out.set(lastCustomer, { at: m.createTime, by: u })
      continue
    }
    lastCustomer = u
  }
  return out
}

/**
 * 取某议题客户的回复：归属表里该客户的最后一条回复，且必须不早于议题锚点。
 * anchorAt 之前的回复属于上一件事，不能算这条议题的跟进。
 */
export function replyForAnchor(
  replies: Map<string, StaffReply>,
  anchorSender: string | undefined,
  anchorAt: number
): StaffReply | null {
  if (!anchorSender) return null
  const hit = replies.get(anchorSender)
  return hit && hit.at >= anchorAt ? hit : null
}

/** 某客户在锚点之后的最后一条发言时间（0 = 窗口内没有） */
export function lastCustomerMessageAt(
  msgs: ChatMessage[],
  anchorAt: number,
  customer: string | undefined
): number {
  if (!customer) return 0
  let last = 0
  for (const m of msgs) {
    if (m.isSend || m.senderUsername !== customer) continue
    if (m.createTime >= anchorAt && m.createTime > last) last = m.createTime
  }
  return last
}
