import type { SessionSummary } from '../../../shared/types'

/**
 * 客户档案派生（客户页/抽屉用）。
 * 所有「状态标签」均由微信真实会话字段（未读数 / 最后消息时间 / 会话类型 / 置顶）实时判断，
 * 不含任何哈希随机 / 示例值；时间窗口以调用方传入的 now 为基准（避免渲染期取 Date.now）。
 */

export interface CustomerProfile {
  wxid: string
  /** 展示名（备注 > 昵称 > 微信号） */
  name: string
  remark: string
  nickname: string
  /** 实时行为状态标签（可多标签，用于列表筛选与画像展示） */
  statusTags: string[]
  /** 最近一条消息时间（毫秒） */
  lastActive: number
  unreadCount: number
  summary: string
  isGroup: boolean
  session: SessionSummary
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
/** 超时未回：有未读且最后消息距今超 2 小时 */
const OVERDUE_MS = 2 * HOUR_MS
/** 沉睡召回窗口：7~30 天未联系 */
const SLEEP_MIN_MS = 7 * DAY_MS
const SLEEP_MAX_MS = 30 * DAY_MS

/** 筛选按钮的展示顺序（只渲染当前存在对应客户的标签） */
const TAG_ORDER = [
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

/** 依据真实会话字段计算状态标签 */
function statusTagsOf(s: SessionSummary, now: number): string[] {
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
    if (gap <= DAY_MS) tags.push('今日互动')
    else if (gap <= SLEEP_MIN_MS) tags.push('近7日互动')
    else if (gap <= SLEEP_MAX_MS) tags.push('沉睡客户')
    else tags.push('久未联系')
  }
  return tags
}

export function deriveCustomers(sessions: SessionSummary[], now: number): CustomerProfile[] {
  return (
    sessions
      .filter((s) => !s.isOfficialAccount && !s.isFoldGroup)
      .map((s) => ({
        wxid: s.username,
        name: s.displayName || s.username,
        remark: s.remark || '',
        nickname: s.nickname || '',
        statusTags: statusTagsOf(s, now),
        lastActive: s.lastTimestamp,
        unreadCount: s.unreadCount,
        summary: s.summary,
        isGroup: s.isGroup,
        session: s
      }))
      // 待回复优先，其次按最近活跃倒序
      .sort((a, b) => {
        const ra = a.unreadCount > 0 ? 1 : 0
        const rb = b.unreadCount > 0 ? 1 : 0
        return rb - ra || b.lastActive - a.lastActive
      })
  )
}

export { TAG_ORDER }
