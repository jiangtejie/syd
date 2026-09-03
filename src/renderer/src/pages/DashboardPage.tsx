import { useCallback, useEffect, useMemo, useState } from 'react'
import { useWorkbenchStore } from '../stores/workbench'
import { avatarColor } from '../lib/ui'
import EChart from '../components/EChart'
import type { EChartsOption } from 'echarts'
import type {
  SendOverview,
  SessionSummary,
  SendStatusInfo,
  OpsStats,
  OpsDayPoint,
  OpsHourPoint,
  OpsTypeCount,
  FeedbackIssue,
  FeedbackIssueDetail,
  FeedbackIssueStatus,
  FeedbackIssueType,
  FeedbackAnalysisState
} from '../../../shared/types'
import './dashboard.css'
import './dashboard-feedback.css'

/**
 * 私域运营看板：顶部运营指标带 + 跟进队列（待回复/沉睡召回）+ 会话与发送审计。
 * 会话类指标来自真实微信库（sessions）；发送统计全部来自本地审计日志 send_log。
 * 不使用任何 mock / 哈希示例数据。
 */

interface DayStat {
  day: string
  sent: number
  failed: number
}

/** 超时未回阈值：有未读且最后消息距今超过该时长 */
const OVERDUE_MS = 2 * 3600_000
/** 队列单列表格最大展示条数 */
const QUEUE_SHOW = 12

// ── 问题反馈：类型配色 / 状态文案 / 表格展示上限 ──
const FB_TYPE_COLORS: Record<FeedbackIssueType, string> = {
  客诉: '#fa5151',
  售后: '#fa8c16',
  物流: '#9d5bfa',
  价格: '#eb2f96',
  咨询: '#5b8ff9',
  建议: '#07c160',
  其他: '#9aa3ad'
}
const FB_STATUS_LABEL: Record<FeedbackIssueStatus, string> = {
  open: '待处理',
  done: '已处理',
  stalled: '已搁置',
  archived: '已归档'
}
const FB_TAB_ORDER: Array<FeedbackIssueStatus | 'all'> = ['open', 'done', 'stalled', 'archived', 'all']
const FB_TAB_LABEL: Record<string, string> = { ...FB_STATUS_LABEL, all: '全部' }
/** 问题反馈表格每页条数选项 */
const FB_PAGE_SIZES = [10, 20, 50, 100]

/** 会话构成片段（真实分类，来自 SessionSummary 的类型标记） */
interface CompSegment {
  key: string
  label: string
  color: string
  n: number
}

const RESULT_LABEL: Record<string, string> = {
  sent: '成功',
  failed: '失败',
  rejected: '被频控拦截',
  halted: '熔断拦截'
}

/** 相对时间文案（纯函数，now 由外部传入避免渲染期取时间） */
function fmtAge(now: number, ts: number): string {
  if (!now || !ts) return ''
  const diff = now - ts
  if (diff < 0) return '刚刚'
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days === 1) return '昨天'
  return `${days} 天前`
}

/** 占比（0~100 取整），total 为 0 时返回 0 */
function pct(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0
}

/** 图表统一色板（与主调一致，避免 CSS/TSX 两处各自硬编码） */
const CHART_GREEN = '#07c160'
const CHART_BLUE = '#5b8ff9'
const CHART_RED = '#fa5151'
const CHART_AMBER = '#f0b429'
const CHART_AXIS_LABEL = { color: '#8a9099', fontSize: 10 }
const CHART_AXIS_LINE = { color: '#d9dde2' }
const CHART_SPLIT_LINE = { lineStyle: { color: '#eef0f3' } }
const CHART_LEGEND = {
  top: 0,
  right: 0,
  icon: 'circle',
  itemWidth: 8,
  itemHeight: 8,
  itemGap: 12,
  textStyle: { fontSize: 11, color: '#6b7280' }
} as const

interface DonutSlice {
  name: string
  value: number
  color: string
}

/** 环形图 option（图例置底、中心大数字 + 说明，名称自带计数） */
function donutOption(slices: DonutSlice[], centerText: string, centerSub: string): EChartsOption {
  return {
    animationDuration: 400,
    tooltip: { trigger: 'item', confine: true, formatter: '{b} · {d}%' },
    legend: {
      bottom: 0,
      left: 'center',
      icon: 'circle',
      itemWidth: 8,
      itemHeight: 8,
      itemGap: 14,
      textStyle: { fontSize: 11, color: '#6b7280' }
    },
    graphic: [
      {
        type: 'text',
        left: 'center',
        top: '26%',
        style: {
          text: centerText,
          fill: '#1f2329',
          fontSize: 19,
          fontWeight: 700,
          textAlign: 'center'
        }
      },
      {
        type: 'text',
        left: 'center',
        top: '38%',
        style: { text: centerSub, fill: '#999', fontSize: 10, textAlign: 'center' }
      }
    ] as unknown as EChartsOption['graphic'],
    series: [
      {
        name: '占比',
        type: 'pie',
        radius: ['52%', '74%'],
        center: ['50%', '45%'],
        avoidLabelOverlap: true,
        label: { show: false },
        itemStyle: { borderColor: '#fff', borderWidth: 2 },
        data: slices.map((s) => ({
          name: `${s.name} ${s.value}`,
          value: s.value,
          itemStyle: { color: s.color }
        }))
      }
    ]
  }
}

/** 每日收发堆叠柱（近 30 日时自动抽稀日期标签） */
function OpsTrend({ points }: { points: OpsDayPoint[] }): React.JSX.Element {
  const option = useMemo<EChartsOption>(() => {
    const step = Math.max(1, Math.ceil(points.length / 6))
    const xData = points.map((p, i) => (i % step === 0 ? p.day : ''))
    return {
      animationDuration: 300,
      grid: { left: 8, right: 8, top: 30, bottom: 0, containLabel: true },
      tooltip: { trigger: 'axis', confine: true, axisPointer: { type: 'shadow' } },
      legend: { ...CHART_LEGEND, data: ['客户发', '我回复'] },
      xAxis: {
        type: 'category',
        data: xData,
        axisTick: { show: false },
        axisLine: { lineStyle: CHART_AXIS_LINE },
        axisLabel: CHART_AXIS_LABEL
      },
      yAxis: {
        type: 'value',
        minInterval: 1,
        axisLabel: CHART_AXIS_LABEL,
        splitLine: CHART_SPLIT_LINE
      },
      series: [
        {
          name: '我回复',
          type: 'bar',
          stack: 'trend',
          barMaxWidth: 22,
          data: points.map((p) => p.outbound),
          itemStyle: { color: CHART_GREEN, borderRadius: [0, 0, 4, 4] }
        },
        {
          name: '客户发',
          type: 'bar',
          stack: 'trend',
          barMaxWidth: 22,
          data: points.map((p) => p.inbound),
          itemStyle: { color: CHART_BLUE, borderRadius: [4, 4, 0, 0] }
        }
      ]
    }
  }, [points])
  return <EChart option={option} height={190} />
}

/** 24 小时时段分布（堆叠客户发/我发，4 小时一个刻度） */
function OpsHours({ hours }: { hours: OpsHourPoint[] }): React.JSX.Element {
  const option = useMemo<EChartsOption>(() => {
    const xData = hours.map((h) => (h.hour % 4 === 0 ? String(h.hour) : ''))
    return {
      animationDuration: 300,
      grid: { left: 8, right: 8, top: 14, bottom: 0, containLabel: true },
      tooltip: { trigger: 'axis', confine: true, axisPointer: { type: 'shadow' } },
      xAxis: {
        type: 'category',
        data: xData,
        axisTick: { show: false },
        axisLine: { lineStyle: CHART_AXIS_LINE },
        axisLabel: CHART_AXIS_LABEL
      },
      yAxis: {
        type: 'value',
        minInterval: 1,
        axisLabel: CHART_AXIS_LABEL,
        splitLine: CHART_SPLIT_LINE
      },
      series: [
        {
          name: '我回复',
          type: 'bar',
          stack: 'hours',
          barMaxWidth: 14,
          data: hours.map((h) => h.outbound),
          itemStyle: { color: CHART_GREEN, borderRadius: [0, 0, 3, 3] }
        },
        {
          name: '客户发',
          type: 'bar',
          stack: 'hours',
          barMaxWidth: 14,
          data: hours.map((h) => h.inbound),
          itemStyle: { color: CHART_BLUE, borderRadius: [3, 3, 0, 0] }
        }
      ]
    }
  }, [hours])
  let peakHour = -1
  let peakVal = 0
  let peakIn = 0
  for (const h of hours) {
    const total = h.inbound + h.outbound
    if (total > peakVal) {
      peakVal = total
      peakHour = h.hour
      peakIn = h.inbound
    }
  }
  return (
    <>
      <EChart option={option} height={165} />
      {peakVal > 0 && (
        <div className="db-panel-sub">
          活跃高峰：{peakHour} 时（共 {peakVal} 条，客户发 {peakIn}）
        </div>
      )}
    </>
  )
}

/** 近 7 日发送结果堆叠柱（绿=成功 / 红=失败拦截） */
function SendBarChart({ stats }: { stats: DayStat[] }): React.JSX.Element {
  const option = useMemo<EChartsOption>(() => {
    return {
      animationDuration: 300,
      grid: { left: 8, right: 8, top: 26, bottom: 0, containLabel: true },
      tooltip: { trigger: 'axis', confine: true, axisPointer: { type: 'shadow' } },
      legend: { ...CHART_LEGEND, data: ['成功', '失败/拦截'] },
      xAxis: {
        type: 'category',
        data: stats.map((d) => d.day),
        axisTick: { show: false },
        axisLine: { lineStyle: CHART_AXIS_LINE },
        axisLabel: CHART_AXIS_LABEL
      },
      yAxis: {
        type: 'value',
        minInterval: 1,
        axisLabel: CHART_AXIS_LABEL,
        splitLine: CHART_SPLIT_LINE
      },
      series: [
        {
          name: '成功',
          type: 'bar',
          stack: 'send',
          barMaxWidth: 26,
          data: stats.map((d) => d.sent),
          itemStyle: { color: CHART_GREEN, borderRadius: [0, 0, 4, 4] }
        },
        {
          name: '失败/拦截',
          type: 'bar',
          stack: 'send',
          barMaxWidth: 26,
          data: stats.map((d) => d.failed),
          itemStyle: { color: CHART_RED, borderRadius: [4, 4, 0, 0] }
        }
      ]
    }
  }, [stats])
  return <EChart option={option} height={150} />
}

/** 消息类型分布 Top（横向进度条） */
function OpsTypes({ items }: { items: OpsTypeCount[] }): React.JSX.Element {
  if (items.length === 0) return <div className="db-empty">范围内暂无消息</div>
  const shown = items.slice(0, 8)
  const max = Math.max(...shown.map((t) => t.count), 1)
  const hidden = items.slice(shown.length).reduce((sum, t) => sum + t.count, 0)
  return (
    <div className="db-types">
      {shown.map((t) => (
        <div className="db-type-row" key={t.label}>
          <span className="db-type-name" title={`${t.label} ${t.count} 条`}>
            {t.label}
          </span>
          <span className="db-type-bar">
            <i style={{ width: `${(t.count / max) * 100}%` }} />
          </span>
          <span className="db-type-count">{t.count}</span>
        </div>
      ))}
      {hidden > 0 && <div className="db-panel-sub">其余 {hidden} 条分属更小类别</div>}
    </div>
  )
}

function DashboardPage(): React.JSX.Element {
  const sessions = useWorkbenchStore((s) => s.sessions)
  const source = useWorkbenchStore((s) => s.source)
  const wxid = useWorkbenchStore((s) => s.wxid)
  const gotoSession = useWorkbenchStore((s) => s.gotoSession)
  const refreshSessions = useWorkbenchStore((s) => s.refreshSessions)
  const [sendStatus, setSendStatus] = useState<SendStatusInfo | null>(null)
  const [sendStats, setSendStats] = useState<DayStat[]>([])
  const [overview, setOverview] = useState<SendOverview | null>(null)
  /** 消息运营洞察：聚合结果 + 其对应的账号/区间（避免跨账号/区间闪旧数据） */
  const [ops, setOps] = useState<OpsStats | null>(null)
  const [opsAt, setOpsAt] = useState<{ wxid: string; range: number } | null>(null)
  const [opsError, setOpsError] = useState<string | null>(null)
  const [range, setRange] = useState<7 | 30>(7)
  /** 当前时间（mount 时异步测量，避免渲染期调用 Date.now） */
  const [nowMs, setNowMs] = useState<number>(0)

  useEffect(() => {
    const reply = window.api?.cs?.reply
    if (!reply) return
    void reply
      .getSendStatus()
      .then((st) => {
        setNowMs(Date.now())
        setSendStatus(st)
      })
      .catch(() => undefined)
    void reply
      .stats7d()
      .then(setSendStats)
      .catch(() => undefined)
    void reply
      .overview()
      .then((res) => res?.ok && res.data && setOverview(res.data))
      .catch(() => undefined)
  }, [])

  // ── 消息运营洞察：加载 + 订阅微信库变化自动刷新（主进程已按账号失效统计缓存）──
  useEffect(() => {
    if (source !== 'wx' || !wxid) return
    const wxApi = window.api?.cs?.wx
    if (!wxApi?.opsStats) return
    let cancelled = false
    const load = (): void => {
      void wxApi
        .opsStats(wxid, range)
        .then((res) => {
          if (cancelled) return
          if (res?.ok && res.stats) {
            setOps(res.stats)
            setOpsAt({ wxid, range })
            setOpsError(null)
          } else {
            setOps(null)
            setOpsError(res?.error || '统计失败')
          }
        })
        .catch(() => {
          if (!cancelled) {
            setOps(null)
            setOpsError('统计加载异常')
          }
        })
    }
    load()
    const unsubscribe = wxApi.onDbChanged?.((payload) => {
      if (payload.wxid !== wxid) return
      if (payload.info.sessionChanged) void refreshSessions()
      load()
    })
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [wxid, source, range, refreshSessions])

  const opsReady = ops !== null && opsAt?.wxid === wxid && opsAt.range === range
  const opsMsg = opsError && !opsReady ? `统计失败：${opsError}` : null
  const opsTotal = ops?.totals.total ?? 0
  const groupMsg = ops?.totals.group ?? 0
  const privateMsg = ops?.totals.privateChat ?? 0
  const opsShare = pct(groupMsg, opsTotal)
  const opsDonut = useMemo<EChartsOption | null>(
    () =>
      opsTotal > 0
        ? donutOption(
            [
              { name: '群聊', value: groupMsg, color: CHART_BLUE },
              { name: '私聊/个人', value: privateMsg, color: CHART_GREEN }
            ],
            `${opsShare}%`,
            '群消息占比'
          )
        : null,
    [groupMsg, privateMsg, opsTotal, opsShare]
  )
  const resp = ops?.response
  const r30 = resp && resp.samples > 0 ? pct(resp.within30Min, resp.samples) : 0
  const r2h = resp && resp.samples > 0 ? pct(resp.within2h, resp.samples) : 0

  // ── 会话构成（真实：按会话类型标记归类）──
  const comp = useMemo(() => {
    const c = { person: 0, group: 0, official: 0, fold: 0, pinned: 0, collapsed: 0 }
    for (const s of sessions) {
      if (s.isGroup) c.group++
      else if (s.isOfficialAccount) c.official++
      else if (s.isFoldGroup) c.fold++
      else c.person++
      if (s.isPinned) c.pinned++
      if (s.isCollapsed) c.collapsed++
    }
    return c
  }, [sessions])

  const compSegs: CompSegment[] = [
    { key: 'person', label: '个人', color: CHART_GREEN, n: comp.person },
    { key: 'group', label: '群聊', color: CHART_BLUE, n: comp.group },
    { key: 'official', label: '公众号', color: CHART_AMBER, n: comp.official },
    { key: 'fold', label: '折叠聊天', color: '#e4e6eb', n: comp.fold }
  ].filter((s) => s.n > 0)
  const compTotal = compSegs.reduce((sum, s) => sum + s.n, 0)
  const compDonut = useMemo<EChartsOption | null>(
    () =>
      compTotal > 0
        ? donutOption(
            compSegs.map((s) => ({ name: s.label, value: s.n, color: s.color })),
            String(compTotal),
            '会话'
          )
        : null,
    [compSegs, compTotal]
  )

  // ── 跟进队列（真实：unread / 最后一条为客户 / lastTimestamp）──
  const canReply = (s: SessionSummary): boolean =>
    !s.isOfficialAccount && !s.isFoldGroup && !s.isWeCom
  /** 待回复队列：有未读且最后一条是客户消息（自己收尾的会话即使微信未读未清零也不计入），越久未处理越靠前 */
  const followUps = useMemo(
    () =>
      sessions
        .filter((s) => s.unreadCount > 0 && canReply(s) && s.lastMsgIsSend !== true)
        .sort((a, b) => a.lastTimestamp - b.lastTimestamp),
    [sessions]
  )
  const overdueCount =
    nowMs > 0 ? followUps.filter((s) => nowMs - s.lastTimestamp > OVERDUE_MS).length : 0
  const needReply = followUps.length

  // ── 顶部指标（真实）──
  const todayStart =
    nowMs > 0
      ? (() => {
          const d = new Date(nowMs)
          d.setHours(0, 0, 0, 0)
          return d.getTime()
        })()
      : 0
  const todayActive = sessions.filter(
    (s) =>
      !s.isOfficialAccount &&
      !s.isFoldGroup &&
      s.lastTimestamp >= todayStart &&
      s.lastTimestamp <= nowMs
  ).length

  // ── 发送监控（真实 send_log）──
  const totals = overview?.totals ?? {}
  const verifiedRate = overview?.verifiedRate ?? null
  const verifiedPct = verifiedRate === null ? null : Math.round(verifiedRate * 100)

  const hasSends = sendStats.some((d) => d.sent + d.failed > 0)
  const sendRatio = sendStatus
    ? Math.min(100, Math.round((sendStatus.todayCount / Math.max(sendStatus.dailyLimit, 1)) * 100))
    : 0

  // ── 群问题反馈（LLM/规则从近 7 天群消息智能提取，独立整行表格）──
  const issueApi = window.api?.cs?.issue
  const [fbIssues, setFbIssues] = useState<FeedbackIssue[]>([])
  const [fbState, setFbState] = useState<FeedbackAnalysisState | null>(null)
  const [fbTab, setFbTab] = useState<FeedbackIssueStatus | 'all'>('open')
  const [fbBusy, setFbBusy] = useState(false)
  const [fbDetailId, setFbDetailId] = useState<number | null>(null)
  const [fbDetail, setFbDetail] = useState<FeedbackIssueDetail | null>(null)
  const [fbError, setFbError] = useState<string | null>(null)
  const [fbPageSize, setFbPageSize] = useState(10)
  const [fbPage, setFbPage] = useState(1)
  const [fbJump, setFbJump] = useState('')
  const [fbClearing, setFbClearing] = useState(false)

  const loadFb = useCallback((): void => {
    if (!issueApi || !wxid) return
    void issueApi
      .list(wxid)
      .then((res) => {
        if (res.ok && Array.isArray(res.issues)) setFbIssues(res.issues as FeedbackIssue[])
      })
      .catch(() => undefined)
    void issueApi
      .state(wxid)
      .then((res) => {
        if (res.ok && res.state) {
          const s = res.state as FeedbackAnalysisState
          setFbState(s)
          if (s.error) setFbError(s.error)
        }
      })
      .catch(() => undefined)
  }, [issueApi, wxid])

  useEffect(() => {
    if (source !== 'wx' || !issueApi) return
    loadFb()
    const unsubscribe = window.api?.cs?.wx?.onDbChanged?.((payload) => {
      if (payload.wxid === wxid) loadFb()
    })
    return unsubscribe
  }, [source, issueApi, wxid, loadFb])

  const runFbAnalyze = useCallback(async (): Promise<void> => {
    if (!issueApi || !wxid || fbBusy) return
    setFbBusy(true)
    setFbError(null)
    try {
      const res = await issueApi.analyze(wxid)
      if (!res.ok && res.error) setFbError(res.error)
    } catch {
      setFbError('分析过程异常')
    }
    const stateRes = await issueApi.state(wxid)
    if (stateRes.ok && stateRes.state) setFbState(stateRes.state as FeedbackAnalysisState)
    const listRes = await issueApi.list(wxid)
    if (listRes.ok && Array.isArray(listRes.issues)) {
      setFbIssues(listRes.issues as FeedbackIssue[])
    }
    setFbBusy(false)
  }, [issueApi, wxid, fbBusy])

  // 清空当前账号问题数据（需确认；清空后点「重新分析」重新提取）
  const clearFb = useCallback((): void => {
    if (!issueApi || !wxid || fbBusy) return
    if (
      !window.confirm('确定清空当前账号的全部问题反馈记录？\n清空后需点击「重新分析」，从近 7 天群消息重新提取。')
    )
      return
    setFbBusy(true)
    setFbClearing(true)
    setFbError(null)
    void issueApi
      .clear(wxid)
      .then((res) => {
        if (!res.ok) setFbError(res.error ?? '清空失败')
      })
      .catch(() => setFbError('清空过程异常'))
      .finally(() => {
        setFbClearing(false)
        setFbBusy(false)
        setFbDetailId(null)
        setFbDetail(null)
        setFbPage(1)
        setFbTab('open')
        loadFb()
      })
  }, [issueApi, wxid, fbBusy, loadFb])

  const fbStatusCount = useMemo(() => {
    const m: Record<string, number> = { open: 0, done: 0, stalled: 0, archived: 0 }
    for (const i of fbIssues) m[i.status] = (m[i.status] ?? 0) + 1
    return m
  }, [fbIssues])
  const fbTabIssues = useMemo(
    () => (fbTab === 'all' ? fbIssues : fbIssues.filter((i) => i.status === fbTab)),
    [fbIssues, fbTab]
  )
  // 表格分页（数据已全量加载，按当前筛选结果切页）
  const fbTotalPages = Math.max(1, Math.ceil(fbTabIssues.length / fbPageSize))
  const fbCurPage = Math.min(fbPage, fbTotalPages)
  const fbPageItems = useMemo(
    () => fbTabIssues.slice((fbCurPage - 1) * fbPageSize, fbCurPage * fbPageSize),
    [fbTabIssues, fbCurPage, fbPageSize]
  )
  const goFbPage = useCallback(
    (p: number): void => setFbPage(Math.min(Math.max(p, 1), fbTotalPages)),
    [fbTotalPages]
  )
  const applyFbJump = useCallback((): void => {
    const n = Number.parseInt(fbJump, 10)
    if (!Number.isNaN(n)) goFbPage(n)
    setFbJump('')
  }, [fbJump, goFbPage])
  // 切换筛选或每页条数时回到第 1 页
  useEffect(() => {
    setFbPage(1)
    setFbJump('')
  }, [fbTab, fbPageSize])
  const fbTypeCount = useMemo(() => {
    const m = new Map<FeedbackIssueType, number>()
    for (const i of fbIssues) {
      if (i.status === 'archived') continue
      m.set(i.type, (m.get(i.type) ?? 0) + 1)
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [fbIssues])
  const fbTypeTotal = fbTypeCount.reduce((sum, [, n]) => sum + n, 0)
  const fbTypeDonut = useMemo<EChartsOption | null>(() => {
    if (fbTypeTotal === 0) return null
    return donutOption(
      fbTypeCount.map(([t, n]) => ({
        name: `${t} ${n}`,
        value: n,
        color: FB_TYPE_COLORS[t] ?? '#9aa3ad'
      })),
      String(fbTypeTotal),
      '未归档'
    )
  }, [fbTypeCount, fbTypeTotal])

  const toggleFbDetail = useCallback(
    (id: number): void => {
      if (fbDetailId === id) {
        setFbDetailId(null)
        setFbDetail(null)
        return
      }
      setFbDetailId(id)
      setFbDetail(null)
      void issueApi
        ?.detail(id)
        .then((res) => {
          if (res.ok && res.issue) setFbDetail(res.issue as FeedbackIssueDetail)
        })
        .catch(() => undefined)
    },
    [issueApi, fbDetailId]
  )

  const setFbStatus = useCallback(
    (id: number, status: FeedbackIssueStatus): void => {
      setFbIssues((prev) => prev.map((i) => (i.id === id ? { ...i, status } : i)))
      void issueApi
        ?.setStatus(id, status)
        .then((res) => {
          if (!res.ok) loadFb()
        })
        .catch(() => {
          loadFb()
        })
    },
    [issueApi, loadFb]
  )

  return (
    <div className="page-scroll">
      <h2 className="page-title">数据看板</h2>
      <div className="page-subtitle">
        {source === 'wx' ? '会话与消息指标来自真实微信库' : '未连接微信数据'} ·
        发送统计为真实审计数据（send_log）
      </div>

      {sendStatus?.halted && (
        <div className="db-alert">
          发送通道已熔断（连续校验失败），自动/人工发送均已暂停，请到「设置」页检查并复位。
        </div>
      )}

      {/* 顶部运营指标带 */}
      <div className="db-cards">
        <div className="db-card page-card">
          <div className="db-card-num">{sessions.length}</div>
          <div className="db-card-label">总会话数</div>
        </div>
        <div className="db-card page-card">
          <div className={`db-card-num${needReply > 0 ? ' warn' : ''}`}>{needReply}</div>
          <div className="db-card-label">待回复会话</div>
        </div>
        <div className="db-card page-card">
          <div className={`db-card-num${overdueCount > 0 ? ' warn' : ''}`}>{overdueCount}</div>
          <div className="db-card-label">超时未回（2h+）</div>
        </div>
        <div className="db-card page-card">
          <div className="db-card-num">{todayActive}</div>
          <div className="db-card-label">今日互动会话</div>
        </div>
        <div className="db-card page-card">
          <div className="db-card-num">{sendStatus?.todayCount ?? '—'}</div>
          <div className="db-card-label">今日已发送</div>
        </div>
      </div>

      {/* 跟进队列 + 问题类型分布 */}
      <div className="db-grid db-queue-grid">
        <div className="page-card db-panel">
          <div className="db-panel-title">
            待回复队列
            {needReply > 0 && <span className="db-count-badge">{needReply}</span>}
          </div>
          {followUps.length === 0 ? (
            <div className="db-empty">暂无待回复会话，全部跟进完毕</div>
          ) : (
            <div className="db-q-scroll">
              {followUps.slice(0, QUEUE_SHOW).map((s) => {
                const overdue = nowMs > 0 && nowMs - s.lastTimestamp > OVERDUE_MS
                return (
                  <div
                    key={s.username}
                    className="db-q-item"
                    onClick={() => source === 'wx' && gotoSession(s.username)}
                  >
                    <span className="cu-avatar" style={{ background: avatarColor(s.displayName) }}>
                      {s.displayName.slice(0, 1)}
                    </span>
                    <div className="db-q-main">
                      <div className="db-q-name">
                        <span className="db-q-name-text">{s.displayName}</span>
                        {s.unreadCount > 0 && <span className="db-q-badge">{s.unreadCount}</span>}
                      </div>
                      <div className="db-q-sub">{s.summary}</div>
                    </div>
                    <span className={`db-q-time${overdue ? ' is-overdue' : ''}`}>
                      {fmtAge(nowMs, s.lastTimestamp)}
                    </span>
                  </div>
                )
              })}
              {followUps.length > QUEUE_SHOW && (
                <div className="db-q-more">
                  另有 {followUps.length - QUEUE_SHOW} 个会话，请在对话页处理
                </div>
              )}
            </div>
          )}
        </div>

        <div className="page-card db-panel">
          <div className="db-panel-title">
            问题类型分布
            {fbTypeTotal > 0 && <span className="db-count-badge">{fbTypeTotal}</span>}
          </div>
          {source !== 'wx' ? (
            <div className="db-empty">连接微信数据后，点击「重新分析」提取近 7 天群消息中的问题</div>
          ) : fbTypeTotal === 0 ? (
            <div className="db-empty">
              {fbBusy
                ? '正在从近 7 天群消息中提取问题…'
                : '暂无问题数据，可点击下方「重新分析」开始提取'}
            </div>
          ) : (
            <>
              {fbTypeDonut && <EChart option={fbTypeDonut} height={178} />}
              <div className="db-panel-sub">口径：近 7 天群消息 · 未归档问题</div>
            </>
          )}
        </div>
      </div>

      {/* 问题反馈（近 7 天群消息智能提取 · 独立整行） */}
      <div className="page-card db-panel db-fb">
        <div className="db-fb-head">
          <div className="db-fb-title-group">
            <span className="db-panel-title">问题反馈</span>
            <span className="db-panel-hint">
              近 7 天群消息 · {fbState?.method === 'llm' ? 'AI 模型提取' : '本地规则提取'} ·
              人工状态持久保存
            </span>
          </div>
          <div className="db-fb-actions">
            <span className="db-seg">
              {FB_TAB_ORDER.map((t) => (
                <button
                  type="button"
                  key={t}
                  className={`db-seg-btn${fbTab === t ? ' on' : ''}`}
                  onClick={() => setFbTab(t)}
                >
                  {FB_TAB_LABEL[t]}
                  {t !== 'all' && (fbStatusCount[t] ?? 0) > 0 ? ` ${fbStatusCount[t] ?? 0}` : ''}
                </button>
              ))}
            </span>
            <button
              type="button"
              className="db-fb-run db-fb-clear"
              disabled={fbBusy || source !== 'wx'}
              onClick={clearFb}
            >
              {fbClearing ? '清空中…' : '清空数据'}
            </button>
            <button
              type="button"
              className="db-fb-run"
              disabled={fbBusy || source !== 'wx'}
              onClick={() => void runFbAnalyze()}
            >
              {fbBusy && !fbClearing ? '分析中…' : '重新分析'}
            </button>
          </div>
        </div>

        {fbError && <div className="db-alert">问题分析失败：{fbError}（未配置模型时使用本地规则）</div>}
        {fbTabIssues.length === 0 ? (
          <div className="db-empty">
            {source !== 'wx'
              ? '连接微信数据后，点击「重新分析」提取群内客户问题/反馈'
              : fbBusy
                ? '正在扫描近 7 天群消息并提取问题…'
                : '当前筛选下暂无问题。可点击「重新分析」从近 7 天群消息中提取'}
          </div>
        ) : (
          <>
            <div className="fb-table">
              <div className="fb-row fb-row-head">
                <span className="fb-col-group">群来源</span>
                <span className="fb-col-content">问题内容（图文）</span>
                <span className="fb-col-type">类型</span>
                <span className="fb-col-msg">相关消息</span>
                <span className="fb-col-time">最近发生</span>
                <span className="fb-col-status">状态</span>
                <span className="fb-col-ops">操作</span>
              </div>
              {fbPageItems.map((it) => (
                <div className="fb-item" key={it.id}>
                  <div className="fb-row">
                    <span className="fb-col-group">
                      <span className="fb-group">
                        <span
                          className="cu-avatar"
                          style={{ background: avatarColor(it.groupName || it.groupUsername) }}
                        >
                          {(it.groupName || it.groupUsername).slice(0, 1)}
                        </span>
                        <span className="fb-group-name" title={it.groupName}>
                          {it.groupName || it.groupUsername}
                        </span>
                      </span>
                    </span>
                    <span className="fb-col-content">
                      <span className="fb-title" title={it.summary}>
                        {it.title}
                      </span>
                      {it.summary && <span className="fb-summary">{it.summary}</span>}
                    </span>
                    <span className="fb-col-type">
                      <span className="fb-type" style={{ background: FB_TYPE_COLORS[it.type] }}>
                        {it.type}
                      </span>
                    </span>
                    <span className="fb-col-msg">
                      <button
                        type="button"
                        className={`fb-rel-btn${fbDetailId === it.id ? ' on' : ''}`}
                        onClick={() => void toggleFbDetail(it.id)}
                      >
                        {it.msgCount} 条 {fbDetailId === it.id ? '▲' : '▼'}
                      </button>
                    </span>
                    <span className="fb-col-time">{fmtAge(nowMs, it.occurAt)}</span>
                    <span className="fb-col-status">
                      <span className={`fb-st fb-st-${it.status}`}>
                        {FB_STATUS_LABEL[it.status]}
                      </span>
                    </span>
                    <span className="fb-col-ops">
                      {it.status !== 'done' && (
                        <button type="button" className="fb-op" onClick={() => setFbStatus(it.id, 'done')}>
                          已处理
                        </button>
                      )}
                      {it.status !== 'stalled' && it.status !== 'archived' && (
                        <button type="button" className="fb-op" onClick={() => setFbStatus(it.id, 'stalled')}>
                          搁置
                        </button>
                      )}
                      {it.status === 'archived' ? (
                        <button type="button" className="fb-op" onClick={() => setFbStatus(it.id, 'open')}>
                          恢复
                        </button>
                      ) : (
                        <button type="button" className="fb-op" onClick={() => setFbStatus(it.id, 'archived')}>
                          归档
                        </button>
                      )}
                    </span>
                  </div>
                  {fbDetailId === it.id && fbDetail?.id === it.id && (
                    <div className="fb-detail">
                      <div className="fb-detail-title">相关消息（智能关联的原始上下文）</div>
                      {fbDetail.related.length === 0 ? (
                        <div className="fb-detail-empty">暂无消息明细</div>
                      ) : (
                        fbDetail.related.map((m, idx) => (
                          <div className="fb-msg" key={idx}>
                            <span className="fb-msg-time">{fmtAge(nowMs, m.time)}</span>
                            <span className={`fb-msg-sender${m.isSend ? ' is-send' : ''}`}>
                              {m.isSend ? '我方客服' : m.senderName || '群成员'}
                            </span>
                            {m.imageMd5 ? (
                              <span className="fb-msg-img">[图片]</span>
                            ) : (
                              <span className="fb-msg-text">{m.text || '(非文本消息)'}</span>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
            {fbTotalPages > 1 && (
              <div className="fb-pager">
                <span className="fb-pager-info">共 {fbTabIssues.length} 条</span>
                <div className="fb-pager-ctrl">
                  <select
                    className="fb-pager-select"
                    value={fbPageSize}
                    onChange={(e) => setFbPageSize(Number(e.target.value))}
                    aria-label="每页条数"
                  >
                    {FB_PAGE_SIZES.map((n) => (
                      <option key={n} value={n}>
                        {n} 条/页
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="fb-pager-btn"
                    disabled={fbCurPage <= 1}
                    onClick={() => goFbPage(fbCurPage - 1)}
                  >
                    ‹ 上一页
                  </button>
                  <span className="fb-pager-now">
                    第 {fbCurPage} / {fbTotalPages} 页
                  </span>
                  <button
                    type="button"
                    className="fb-pager-btn"
                    disabled={fbCurPage >= fbTotalPages}
                    onClick={() => goFbPage(fbCurPage + 1)}
                  >
                    下一页 ›
                  </button>
                  <div className="fb-pager-jump">
                    <input
                      className="fb-pager-jump-input"
                      placeholder={`跳至 ${fbCurPage}`}
                      value={fbJump}
                      inputMode="numeric"
                      onChange={(e) => setFbJump(e.target.value.replace(/\D/g, ''))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') applyFbJump()
                      }}
                    />
                    <button
                      type="button"
                      className="fb-pager-btn"
                      disabled={fbJump === ''}
                      onClick={applyFbJump}
                    >
                      跳转
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <div className="db-grid">
        {/* 会话构成（真实） */}
        <div className="page-card db-panel">
          <div className="db-panel-title">会话构成</div>
          {compTotal === 0 ? (
            <div className="db-empty">
              {source === 'wx' ? '暂无会话数据' : '连接微信数据后展示'}
            </div>
          ) : compDonut ? (
            <>
              <EChart option={compDonut} height={190} />
              {(comp.pinned > 0 || comp.collapsed > 0) && (
                <div className="db-comp-note">
                  置顶 {comp.pinned} · 折叠 {comp.collapsed}
                </div>
              )}
            </>
          ) : null}
        </div>

        {/* 发送监控（真实） */}
        <div className="page-card db-panel">
          <div className="db-panel-title">发送监控（近 7 日）</div>
          <div className="db-freq">
            <div className="db-freq-row">
              <span>今日频控</span>
              <span>
                {sendStatus ? `${sendStatus.todayCount} / ${sendStatus.dailyLimit}` : '—'}
              </span>
            </div>
            <div className="db-freq-bar">
              <div
                className={`db-freq-fill${sendRatio > 80 ? ' is-high' : ''}`}
                style={{ width: `${sendRatio}%` }}
              />
            </div>
            {sendStatus && sendStatus.queued > 0 && (
              <div className="db-freq-note">队列中等待 {sendStatus.queued} 条</div>
            )}
          </div>
          {!hasSends ? (
            <div className="db-empty">暂无发送记录</div>
          ) : (
            <SendBarChart stats={sendStats} />
          )}
        </div>

      </div>

      {/* 消息运营洞察（真实微信消息库聚合） */}
      <div className="db-sec">
        <div className="db-sec-head">
          <span className="db-panel-title db-sec-title">
            消息运营洞察
            <span className="db-panel-hint">真实微信消息库</span>
          </span>
          {source === 'wx' && (
            <span className="db-seg">
              <button
                type="button"
                className={`db-seg-btn${range === 7 ? ' on' : ''}`}
                onClick={() => setRange(7)}
              >
                近 7 日
              </button>
              <button
                type="button"
                className={`db-seg-btn${range === 30 ? ' on' : ''}`}
                onClick={() => setRange(30)}
              >
                近 30 日
              </button>
            </span>
          )}
        </div>

        {source !== 'wx' ? (
          <div className="page-card db-panel">
            <div className="db-empty">
              连接微信数据后展示消息运营洞察（收发趋势 / 时段分布 / 消息类型 / 响应时效）
            </div>
          </div>
        ) : !opsReady ? (
          <div className="page-card db-panel">
            <div className="db-empty">{opsMsg ?? '正在聚合消息统计…'}</div>
          </div>
        ) : ops ? (
          <>
            <div className="db-grid">
              <div className="page-card db-panel">
                <div className="db-panel-title">每日收发趋势</div>
                <OpsTrend points={ops.trend} />
              </div>
              <div className="page-card db-panel">
                <div className="db-panel-title">24 小时时段分布</div>
                <OpsHours hours={ops.hours} />
              </div>
            </div>

            <div className="db-grid">
              <div className="page-card db-panel">
                <div className="db-panel-title">消息类型分布</div>
                <OpsTypes items={ops.typeDist} />
              </div>
              <div className="page-card db-panel">
                <div className="db-panel-title">群聊 / 私聊分布</div>
                {opsTotal === 0 ? (
                  <div className="db-empty">范围内暂无消息</div>
                ) : opsDonut ? (
                  <EChart option={opsDonut} height={190} />
                ) : null}
              </div>
            </div>
          </>
        ) : null}

        {/* 服务/发送质量收尾行：发送质量（send_log）与服务响应时效（微信消息库）并排 */}
        <div className="db-grid">
          <div className="page-card db-panel">
            <div className="db-panel-title">发送质量（近 7 日）</div>
            <div className="db-freq">
              {Object.keys(totals).length === 0 ? (
                <div className="db-empty">暂无发送记录</div>
              ) : (
                <>
                  <div className="db-freq-row">
                    <span>闭环校验通过率</span>
                    <span>{verifiedPct === null ? '—' : `${verifiedPct}%`}</span>
                  </div>
                  <div className="db-freq-bar">
                    {verifiedPct !== null && (
                      <div
                        className={`db-freq-fill${verifiedPct < 90 ? ' is-high' : ''}`}
                        style={{ width: `${verifiedPct}%` }}
                      />
                    )}
                  </div>
                  {verifiedPct !== null && verifiedPct < 100 && (
                    <div className="db-freq-note">部分成功消息尚未被微信库校验确认</div>
                  )}
                  <div className="db-send-breakdown">
                    {Object.entries(RESULT_LABEL)
                      .filter(([k]) => (totals[k] ?? 0) > 0)
                      .map(([k, label]) => (
                        <span key={k} className={`db-chip db-chip-${k}`}>
                          {label} {totals[k]}
                        </span>
                      ))}
                  </div>
                </>
              )}
            </div>
            <div className="db-panel-sub">失败原因 Top</div>
            {overview && overview.failReasons.length === 0 ? (
              <div className="db-empty">近 7 日无失败记录</div>
            ) : (
              <div className="db-reasons">
                {(overview?.failReasons ?? []).map((r, i) => (
                  <div className="db-reason" key={i}>
                    <span className="db-reason-name">
                      {i + 1}. {r.reason}
                    </span>
                    <span className="db-reason-count">{r.count}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="page-card db-panel">
            <div className="db-panel-title">服务响应时效</div>
            {source !== 'wx' ? (
              <div className="db-empty">连接微信数据后展示</div>
            ) : !opsReady ? (
              <div className="db-empty">{opsMsg ?? '正在聚合消息统计…'}</div>
            ) : resp && resp.samples > 0 ? (
              <div className="db-freq" style={{ maxWidth: 560 }}>
                <div className="db-freq-row">
                  <span>有效样本</span>
                  <span>{resp.samples} 次回复</span>
                </div>
                <div className="db-freq-row">
                  <span>30 分钟内回复</span>
                  <span>{r30}%</span>
                </div>
                <div className="db-freq-bar">
                  <div className="db-freq-fill" style={{ width: `${r30}%` }} />
                </div>
                <div className="db-freq-row">
                  <span>2 小时内回复</span>
                  <span>{r2h}%</span>
                </div>
                <div className="db-freq-bar">
                  <div className="db-freq-fill" style={{ width: `${r2h}%` }} />
                </div>
                <div className="db-freq-row">
                  <span>中位响应时长</span>
                  <span>{resp.medianMinutes === null ? '—' : `${resp.medianMinutes} 分钟`}</span>
                </div>
                <div className="db-freq-row">
                  <span>超 2h 未回待跟进</span>
                  <span className={resp.noResponse > 0 ? 'db-text-warn' : ''}>
                    {resp.noResponse}
                  </span>
                </div>
              </div>
            ) : (
              <div className="db-empty">范围内缺少「客户先发 → 我回复」的会话样本</div>
            )}
          </div>
        </div>
      </div>

      <div className="page-subtitle db-footnote">
        口径：待回复=有未读且最后一条为客户消息（不含公众号/折叠）；超时未回=有未读且最后消息距今超 2
        小时；今日互动=今日有消息的会话；沉睡=近 7~30 天未联系的个人会话。
      </div>
    </div>
  )
}

export default DashboardPage
