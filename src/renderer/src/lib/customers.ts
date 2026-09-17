import type { SessionSummary } from '../../../shared/types'
import {
  compareCustomerProfiles,
  mergeCustomerProfile,
  TAG_ORDER,
  type CustomerStored
} from '../../../shared/customerProfile'

/**
 * 客户档案派生（客户页/抽屉用）。
 *
 * 两层数据合起来才是一个客户：
 * - **会话**（微信给的实时数据）：未读、最后消息时间、会话类型、置顶 → 实时状态标签；
 * - **档案**（我们自己攒的）：来源、内部备注、人工标签、建档时间 → 持久资产。
 * 实时标签的判定已收进 shared/customerProfile.ts（两端一份口径）；这里只做展示映射。
 */

export interface CustomerProfile {
  /** 稳定身份（= 会话 username）；字段名叫 wxid 是历史原因，客户页到处在用 */
  wxid: string
  /** 与 wxid 同值。取这个名字是为了能直接套用 shared 的排序/合并函数（结构化类型） */
  username: string
  /** 展示名（备注 > 昵称 > 微信号） */
  name: string
  remark: string
  nickname: string
  /** 微信号别名（部分联系人存在） */
  alias: string
  /** 实时行为状态标签（可多标签，用于列表筛选与画像展示） */
  statusTags: string[]
  /** 人工打的标签（持久；未建档的客户为空数组） */
  manualTags: string[]
  /** 来源（持久；营销归因用，系统推不出来） */
  source: string
  /** 内部备注（持久；与微信备注不同，微信读不到） */
  note: string
  /** 建档时间（持久；真值只有微信知道，从本功能上线那天开始记） */
  firstSeenAt: number | null
  /** 最近一条消息时间（毫秒） */
  lastActive: number
  unreadCount: number
  summary: string
  isGroup: boolean
  session: SessionSummary
}

/** 客户名单行的副行文本：备注≠昵称时显示真实微信昵称，否则回退微信号别名，避免与主名重复 */
export function secondaryLabel(c: CustomerProfile): string {
  if (c.remark && c.nickname && c.nickname !== c.remark) return c.nickname
  if (c.remark && c.alias && c.alias !== c.remark) return `微信号 ${c.alias}`
  if (!c.remark && c.alias && c.alias !== c.nickname) return `微信号 ${c.alias}`
  return ''
}

export function deriveCustomers(
  sessions: SessionSummary[],
  now: number,
  /** 档案（按 username 索引）；没同步过时传 undefined，行为与从前完全一致 */
  stored?: Map<string, CustomerStored>
): CustomerProfile[] {
  return (
    sessions
      .filter((s) => !s.isOfficialAccount && !s.isFoldGroup)
      .map((s) => {
        const view = mergeCustomerProfile(s, stored?.get(s.username) ?? null, now)
        const profile: CustomerProfile = {
          wxid: s.username,
          username: s.username,
          name: view.name,
          remark: view.remark,
          nickname: view.nickname,
          alias: view.alias,
          statusTags: view.statusTags,
          manualTags: view.manualTags,
          source: view.source,
          note: view.note,
          firstSeenAt: view.firstSeenAt,
          lastActive: view.lastActive,
          unreadCount: view.unreadCount,
          summary: view.summary,
          isGroup: s.isGroup,
          session: s
        }
        return profile
      })
      // 待回复优先，其次按最近活跃倒序（与 shared 共用同一个比较函数，口径不会漂）
      .sort(compareCustomerProfiles)
  )
}

export { TAG_ORDER }
