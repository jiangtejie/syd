import type { SessionSummary } from '../../../shared/types'

/**
 * 客户档案派生（看板/客户页用）。
 * 当前为确定性示例算法（按 username 哈希），保证同一会话每次结果一致；
 * 解密层与客户库（customer 表）接入后替换为真实数据。
 */

export type CustomerTier = 'vip' | 'normal'

export interface CustomerProfile {
  wxid: string
  name: string
  tier: CustomerTier
  tags: string[]
  /** 活跃度评分 0~100（由最近活跃时间 + 未读推导） */
  activeScore: number
  lastActive: number
  unreadCount: number
  summary: string
  isGroup: boolean
  session: SessionSummary
}

const TAG_POOL = ['意向高', '已报价', '待跟进', '老客户', '价格敏感', '技术咨询', '已成交', '需回访']

function hash(str: string): number {
  let h = 0
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0
  return Math.abs(h)
}

export function deriveCustomer(s: SessionSummary): CustomerProfile {
  const h = hash(s.username)
  const isGroup = s.username.endsWith('@chatroom')
  // VIP：约 1/4 客户；群与公众号不参与分层
  const tier: CustomerTier = !isGroup && !s.isOfficialAccount && h % 4 === 0 ? 'vip' : 'normal'
  // 标签：0~3 个，按哈希稳定选取
  const tagCount = h % 4
  const tags: string[] = []
  for (let i = 0; i < tagCount; i++) {
    tags.push(TAG_POOL[(h + i * 3) % TAG_POOL.length])
  }
  // 活跃度：24h 内活跃 80~100，3 天内 50~80，更早 20~50
  const ageMs = Date.now() - s.lastTimestamp
  const dayMs = 24 * 3600_000
  const base = ageMs < dayMs ? 80 : ageMs < 3 * dayMs ? 50 : 20
  const activeScore = Math.min(100, base + (h % 20))
  return {
    wxid: s.username,
    name: s.displayName || s.username,
    tier,
    tags,
    activeScore,
    lastActive: s.lastTimestamp,
    unreadCount: s.unreadCount,
    summary: s.summary,
    isGroup,
    session: s
  }
}

export function deriveCustomers(sessions: SessionSummary[]): CustomerProfile[] {
  return sessions
    .filter((s) => !s.isOfficialAccount)
    .map(deriveCustomer)
    .sort((a, b) => b.lastActive - a.lastActive)
}

/** 确定性伪随机数（同日同种子结果一致），用于示例趋势图 */
export function seededRandom(seed: number): number {
  const x = Math.sin(seed) * 10000
  return x - Math.floor(x)
}
