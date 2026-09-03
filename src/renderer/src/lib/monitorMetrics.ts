import type { FeedbackIssue, FeedbackIssueStatus, FeedbackIssueType } from '../../../shared/types'

/**
 * 问题监控中心指标(BI 聚合纯函数,输入 = 该账号全量 issue,窗口影响趋势统计)。
 * 时间口径:
 * - 新增时间 = occurAt(首现);解决时间 = done 且 updatedAt(状态变更时间,upsert 不再刷新无实质变化的行);
 * - open 积压类指标不受窗口限制(更真实反映当前库存)。
 */

export interface MonitorKpis {
  /** 待处理(未回复) */
  pending: number
  /** 跟进中(已回复未闭环) */
  following: number
  /** 跟进超时(回复后超 12h 未闭环,主进程已算 followUpOverdue) */
  followOverdue: number
  /** 积压超时:open 且首现距今 >48h */
  backlog48: number
  /** 今日新增(occurAt 在今天,排除误报归档) */
  createdToday: number
  /** 今日解决(done 且 updatedAt 在今天) */
  resolvedToday: number
  /** 闭环率 = done ÷ (done + open + stalled) */
  closedRate: number | null
}

export interface TrendPoint {
  day: string
  created: number
  resolved: number
}

export interface MonitorData {
  kpis: MonitorKpis
  trend: TrendPoint[]
  /** open 问题类型分布(环形) */
  typeOpen: Array<{ name: string; value: number }>
  /** open 最多的群 Top(钻取联动) */
  groupTop: Array<{ name: string; username: string; value: number }>
  /** open 积压年龄分布 */
  age: Array<{ label: string; value: number }>
}

const TYPE_ORDER: FeedbackIssueType[] = ['客诉', '售后', '物流', '价格', '咨询', '建议', '其他']

export interface MonitorOptions {
  /** 积压超时阈值(小时,默认 48) */
  backlogHours?: number
}

function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function computeMonitorData(
  issues: FeedbackIssue[],
  rangeDays: number,
  opts: MonitorOptions = {},
  now = Date.now()
): MonitorData {
  const today0 = startOfDay(now)
  const rangeStart = today0 - (rangeDays - 1) * 24 * 3600_000
  const days = Math.min(Math.max(Math.floor(rangeDays), 1), 90)
  const backlogMs = Math.max(1, Math.floor(opts.backlogHours ?? 48)) * 3600_000

  // 趋势:每一天的 新增(occur)与 解决(done updated)
  const trendMap = new Map<number, TrendPoint>()
  for (let i = 0; i < days; i++) {
    const day0 = today0 - i * 24 * 3600_000
    const d = new Date(day0)
    trendMap.set(day0, {
      day: `${d.getMonth() + 1}/${d.getDate()}`,
      created: 0,
      resolved: 0
    })
  }
  // 按天降序生成数组后反转升序
  for (const it of issues) {
    if (it.status === 'archived') continue
    const oDay = startOfDay(it.occurAt)
    if (oDay >= rangeStart && oDay <= today0) {
      const p = trendMap.get(oDay)
      if (p) p.created++
    }
    if (it.status === 'done') {
      const rDay = startOfDay(it.updatedAt)
      if (rDay >= rangeStart && rDay <= today0) {
        const p = trendMap.get(rDay)
        if (p) p.resolved++
      }
    }
  }
  const trend: TrendPoint[] = Array.from(trendMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v)

  // KPI
  let pending = 0
  let following = 0
  let followOverdue = 0
  let backlog48 = 0
  let createdToday = 0
  let resolvedToday = 0
  let done = 0
  let stalled = 0
  let openTotal = 0

  const typeCount = new Map<FeedbackIssueType, number>()
  for (const t of TYPE_ORDER) typeCount.set(t, 0)
  const groupCount = new Map<string, { name: string; username: string; value: number }>()
  const ageBuckets = [
    { label: '<24h', value: 0 },
    { label: '1~3 天', value: 0 },
    { label: '3~7 天', value: 0 },
    { label: '>7 天', value: 0 }
  ]

  for (const it of issues) {
    const st = it.status
    if (st === 'done') done++
    else if (st === 'stalled') stalled++
    else if (st === 'archived') continue

    if (it.status !== 'archived') {
      if (startOfDay(it.occurAt) === today0) createdToday++
    }
    if (st === 'done' && startOfDay(it.updatedAt) === today0) resolvedToday++

    if (st === 'open') {
      openTotal++
      if (it.followUp) {
        following++
        if (it.followUpOverdue) followOverdue++
      } else {
        pending++
      }
      if (now - it.occurAt > backlogMs) backlog48++
      const age = now - it.occurAt
      const dayMs = 24 * 3600_000
      const ageLabel =
        age < dayMs ? '<24h' : age < 3 * dayMs ? '1~3 天' : age < 7 * dayMs ? '3~7 天' : '>7 天'
      const b = ageBuckets.find((x) => x.label === ageLabel)
      if (b) b.value++
      typeCount.set(it.type, (typeCount.get(it.type) ?? 0) + 1)
      const g = groupCount.get(it.groupUsername)
      if (g) g.value++
      else groupCount.set(it.groupUsername, { name: it.groupName || it.groupUsername, username: it.groupUsername, value: 1 })
    }
  }

  const closedBase = done + openTotal + stalled
  const kpis: MonitorKpis = {
    pending,
    following,
    followOverdue,
    backlog48,
    createdToday,
    resolvedToday,
    closedRate: closedBase > 0 ? Math.round((done / closedBase) * 1000) / 10 : null
  }

  return {
    kpis,
    trend,
    typeOpen: TYPE_ORDER.filter((t) => (typeCount.get(t) ?? 0) > 0).map((t) => ({
      name: t,
      value: typeCount.get(t) ?? 0
    })),
    groupTop: Array.from(groupCount.values())
      .sort((a, b) => b.value - a.value)
      .slice(0, 10),
    age: ageBuckets
  }
}

export const MONITOR_STATUS_LABEL: Record<FeedbackIssueStatus, string> = {
  open: '待处理',
  done: '已解决',
  stalled: '已搁置',
  archived: '已归档'
}

export function fmtTimeShort(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const sameDay = (now: Date): boolean =>
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (sameDay(new Date())) return `今天 ${hm}`
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
}

export function ageText(ts: number, now = Date.now()): string {
  const ms = now - ts
  const h = Math.floor(ms / 3600_000)
  if (h < 1) return `${Math.max(1, Math.floor(ms / 60000))} 分钟`
  if (h < 24) return `${h} 小时`
  const days = Math.floor(h / 24)
  return `${days} 天`
}
