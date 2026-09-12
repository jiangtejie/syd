import type { FeedbackIssue, FeedbackIssueStatus, FeedbackIssueType } from './types'

/**
 * 问题监控中心指标(BI 聚合纯函数,输入 = 该账号全量 issue,窗口影响趋势统计)。
 * 放在 shared:主进程用它在 **不把全量问题过 IPC** 的前提下算 KPI/趋势(见 cs:issue:overview),
 * 渲染端复用同一份口径,避免两端算法漂移。
 * 时间口径:
 * - 新增时间 = occurAt(首现);
 * - 解决时间 = resolvedAt(置 done/stalled 时写入,重开清空)——旧数据缺该字段时回落 updatedAt。
 *   注意不能用 updatedAt 当唯一口径:重析对内容有变化的行会刷新它,会把老问题的解决日算到今天;
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
  /** 闭环率 = (done + 已闭环后归档) ÷ (done + open + stalled + 已闭环后归档) */
  closedRate: number | null
  /** 已闭环后归档的历史条数（计入闭环率，不再占用活跃列表；人工「不是问题」的归档不计入） */
  archivedClosed: number
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

/** 闭环时间：resolvedAt 优先(精确到状态流转时刻)，旧数据回落 updatedAt */
function resolvedTime(it: FeedbackIssue): number {
  return it.resolvedAt ?? it.updatedAt
}

/**
 * 是否是「已闭环后被归档」的历史记录（archived_from = done/stalled）。
 * 这类记录要照旧计入闭环率与趋势，只是不再出现在活跃列表里；
 * 人工把未解决的议题标成「不是问题」的归档(archived_from=open)不算闭环。
 */
function isArchivedClosed(it: FeedbackIssue): boolean {
  return it.status === 'archived' && (it.archivedFrom === 'done' || it.archivedFrom === 'stalled')
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
    if (it.status === 'archived' && !isArchivedClosed(it)) continue
    const oDay = startOfDay(it.occurAt)
    if (oDay >= rangeStart && oDay <= today0) {
      const p = trendMap.get(oDay)
      if (p) p.created++
    }
    if (it.status === 'done' || isArchivedClosed(it)) {
      const rDay = startOfDay(resolvedTime(it))
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
  let archivedClosed = 0

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
    else if (st === 'archived') {
      if (isArchivedClosed(it)) archivedClosed++
      continue
    }

    if (it.status !== 'archived') {
      if (startOfDay(it.occurAt) === today0) createdToday++
    }
    if (st === 'done' && startOfDay(resolvedTime(it)) === today0) resolvedToday++

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
      else
        groupCount.set(it.groupUsername, {
          name: it.groupName || it.groupUsername,
          username: it.groupUsername,
          value: 1
        })
    }
  }

  const closedBase = done + openTotal + stalled + archivedClosed
  const kpis: MonitorKpis = {
    pending,
    following,
    followOverdue,
    backlog48,
    createdToday,
    resolvedToday,
    archivedClosed,
    closedRate:
      closedBase > 0 ? Math.round(((done + archivedClosed) / closedBase) * 1000) / 10 : null
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
  // 空/非有限值直接留白：new Date(null) = 1970-01-01 08:00，会伪装成「1月1日 08:00」这种真实时间
  if (!ts || !Number.isFinite(ts)) return '—'
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
  // 空值参与 now - ts 会算出上万年（NULL 被当成 0），先挡住
  if (!ts || !Number.isFinite(ts)) return '—'
  const ms = now - ts
  const h = Math.floor(ms / 3600_000)
  if (h < 1) return `${Math.max(1, Math.floor(ms / 60000))} 分钟`
  if (h < 24) return `${h} 小时`
  const days = Math.floor(h / 24)
  return `${days} 天`
}
