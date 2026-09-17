import type { SessionSummary } from './types'

/**
 * 客户档案的**纯逻辑**（两端共用、零依赖、可离线自检）。
 *
 * 为什么搬到这里：以前「客户标签」是渲染端一份实时派生的口径（lib/customers.ts），
 * 主进程若也要按同一口径筛选（触达目标、归因统计）就会**再写一份** —— 同一件事两个口径，
 * 迟早出现「客户页说有 37 个待回复、看板说 31 个」。这里定成一份，两端都调它。
 */

/** 超时未回：有未读且最后消息距今超 2 小时 */
export const OVERDUE_MS = 2 * 3600_000
/** 沉睡召回窗口：7~30 天未联系 */
export const SLEEP_MIN_MS = 7 * 86400_000
export const SLEEP_MAX_MS = 30 * 86400_000

/** 筛选按钮的展示顺序（只渲染当前存在对应客户的标签） */
export const TAG_ORDER: string[] = [
  '待回复',
  '超时未回',
  '今日互动',
  '近7日互动',
  '沉睡客户',
  '久未联系',
  '群聊',
  '个人',
  '置顶'
]

/** 依据真实会话字段计算**实时**状态标签（不落库：它是「此刻的状态」，不是客户的属性） */
export function statusTagsOf(s: SessionSummary, now: number): string[] {
  const tags: string[] = []
  tags.push(s.isGroup ? '群聊' : '个人')
  if (s.isPinned) tags.push('置顶')

  const ts = s.lastTimestamp
  const gap = now > 0 && ts > 0 ? now - ts : -1

  if (s.unreadCount > 0) {
    tags.push('待回复')
    if (gap >= 0 && gap > OVERDUE_MS) tags.push('超时未回')
  }
  if (gap >= 0) {
    if (gap <= 86400_000) tags.push('今日互动')
    else if (gap <= SLEEP_MIN_MS) tags.push('近7日互动')
    else if (gap <= SLEEP_MAX_MS) tags.push('沉睡客户')
    else tags.push('久未联系')
  }
  return tags
}

/** 库里的客户档案（customer_profile 一行 + 它的标签）。用户填的字段永远不该被会话同步覆盖 */
export interface CustomerStored {
  username: string
  displayName: string
  remark: string
  nickname: string
  alias: string
  isGroup: boolean
  /** 来源：营销归因用（内容/渠道/门店…），系统推不出来 */
  source: string
  note: string
  firstSeenAt: number | null
  lastActiveAt: number | null
  /** 人工打的标签（资产） */
  manualTags: string[]
  /** 规则算出来的标签（可重算） */
  derivedTags: string[]
}

/** 会话（实时）+ 档案（持久）合并后的客户视图 */
export interface CustomerProfileView {
  /** 稳定身份：会话/联系人 username */
  username: string
  name: string
  remark: string
  nickname: string
  alias: string
  isGroup: boolean
  /** 实时状态标签（由会话算，不落库） */
  statusTags: string[]
  /** 人工标签（持久，列表筛选与触达目标都用它） */
  manualTags: string[]
  source: string
  note: string
  firstSeenAt: number | null
  lastActive: number
  unreadCount: number
  summary: string
}

/**
 * 合并：**实时字段以会话为准，用户填的字段以档案为准**。
 *
 * 反过来（用档案覆盖会话）会让改名/改备注后列表显示旧名字；
 * 而用会话覆盖 source/note/tags 就直接把用户数据抹了 —— 这两条都不能错。
 */
export function mergeCustomerProfile(
  session: SessionSummary,
  stored: CustomerStored | null | undefined,
  now: number
): CustomerProfileView {
  return {
    username: session.username,
    name: session.displayName || session.username,
    remark: session.remark || '',
    nickname: session.nickname || '',
    alias: session.alias || '',
    isGroup: session.isGroup,
    statusTags: statusTagsOf(session, now),
    manualTags: stored?.manualTags ?? [],
    source: stored?.source ?? '',
    note: stored?.note ?? '',
    firstSeenAt: stored?.firstSeenAt ?? null,
    lastActive: session.lastTimestamp,
    unreadCount: session.unreadCount,
    summary: session.summary || ''
  }
}

/** 客户名单行排序：待回复优先，其次按最近活跃倒序 */
export function compareCustomerProfiles(a: CustomerProfileView, b: CustomerProfileView): number {
  const ra = a.unreadCount > 0 ? 1 : 0
  const rb = b.unreadCount > 0 ? 1 : 0
  return rb - ra || b.lastActive - a.lastActive
}
