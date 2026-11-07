import { useEffect, useMemo, useState } from 'react'
import { useWorkbenchStore } from '../stores/workbench'
import { avatarColor } from '../lib/ui'
import { useChartTheme } from '../lib/useChartTheme'
import type { ChartColors } from '../lib/theme'
import { fmtStamp } from '../../../shared/monitorMetrics'
import EChart from '../components/EChart'
import ConnectGuide from '../components/ConnectGuide'
import type { EChartsOption } from 'echarts'
import type {
  SendOverview,
  SessionSummary,
  SendStatusInfo,
  OpsStats,
  OpsDayPoint,
  OpsHourPoint,
  OpsTypeCount
} from '../../../shared/types'
import './dashboard.css'

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

/** 发送结果 → 统一徽标语气(ui-chip 的 is-ok/is-warn/is-bad) */
const RESULT_TONE: Record<string, string> = {
  sent: 'ok',
  failed: 'bad',
  rejected: 'warn',
  halted: 'bad'
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

/** 面板内空态：统一 .ui-empty 结构（标题 + 说明，可选雷达图标），不再只留一句灰字 */
function DbEmpty({
  title,
  desc,
  glyph
}: {
  title: string
  desc?: string
  glyph?: boolean
}): React.JSX.Element {
  return (
    <div className="ui-empty db-empty">
      {glyph && (
        <div className="ui-empty-glyph" aria-hidden="true">
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 19V5M4 19h16" />
            <path d="M8 15l3-4 3 2 4-6" />
          </svg>
        </div>
      )}
      <div className="ui-empty-title">{title}</div>
      {desc && <div className="ui-empty-desc">{desc}</div>}
    </div>
  )
}

/** 轴/图例/分隔线：色值来自当前主题（useChartTheme），这里只定义图表内的字号与图标尺寸 */
const AXIS_FONT = 10
const LEGEND_FONT = 11

function axisLabel(c: ChartColors): { color: string; fontSize: number } {
  return { color: c.axisLabel, fontSize: AXIS_FONT }
}

function axisLine(c: ChartColors): { color: string } {
  return { color: c.axisLine }
}

function splitLine(c: ChartColors): { lineStyle: { color: string } } {
  return { lineStyle: { color: c.splitLine } }
}

/** 图例基础样式（颜色随主题；各图只覆盖 data 与位置） */
function legendBase(c: ChartColors): Record<string, unknown> {
  return {
    top: 0,
    right: 0,
    icon: 'circle',
    itemWidth: 8,
    itemHeight: 8,
    itemGap: 12,
    textStyle: { fontSize: LEGEND_FONT, color: c.legendText }
  }
}

interface DonutSlice {
  name: string
  value: number
  color: string
}

/** 环形图 option（图例置底、中心大数字 + 说明，名称自带计数） */
function donutOption(
  slices: DonutSlice[],
  centerText: string,
  centerSub: string,
  c: ChartColors
): EChartsOption {
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
      textStyle: { fontSize: LEGEND_FONT, color: c.legendText }
    },
    graphic: [
      {
        type: 'text',
        left: 'center',
        top: '26%',
        style: {
          text: centerText,
          fill: c.text,
          fontSize: 19,
          fontFamily: 'ui-monospace, Consolas, monospace',
          fontWeight: 700,
          textAlign: 'center'
        }
      },
      {
        type: 'text',
        left: 'center',
        top: '38%',
        style: { text: centerSub, fill: c.legendText, fontSize: 10, textAlign: 'center' }
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
        itemStyle: { borderColor: 'transparent', borderWidth: 2 },
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
  const c = useChartTheme()
  const option = useMemo<EChartsOption>(() => {
    const step = Math.max(1, Math.ceil(points.length / 6))
    const xData = points.map((p, i) => (i % step === 0 ? p.day : ''))
    return {
      animationDuration: 300,
      grid: { left: 8, right: 8, top: 30, bottom: 0, containLabel: true },
      tooltip: { trigger: 'axis', confine: true, axisPointer: { type: 'shadow' } },
      legend: { ...legendBase(c), data: ['客户发', '我回复'] },
      xAxis: {
        type: 'category',
        data: xData,
        axisTick: { show: false },
        axisLine: { lineStyle: axisLine(c) },
        axisLabel: axisLabel(c)
      },
      yAxis: {
        type: 'value',
        minInterval: 1,
        axisLabel: axisLabel(c),
        splitLine: splitLine(c)
      },
      series: [
        {
          name: '我回复',
          type: 'bar',
          stack: 'trend',
          barMaxWidth: 22,
          data: points.map((p) => p.outbound),
          itemStyle: { color: c.brand, borderRadius: [0, 0, 4, 4] }
        },
        {
          name: '客户发',
          type: 'bar',
          stack: 'trend',
          barMaxWidth: 22,
          data: points.map((p) => p.inbound),
          itemStyle: { color: c.blue, borderRadius: [4, 4, 0, 0] }
        }
      ]
    }
  }, [points, c])
  return <EChart option={option} height={190} />
}

/** 24 小时时段分布（堆叠客户发/我发，4 小时一个刻度） */
function OpsHours({ hours }: { hours: OpsHourPoint[] }): React.JSX.Element {
  const c = useChartTheme()
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
        axisLine: { lineStyle: axisLine(c) },
        axisLabel: axisLabel(c)
      },
      yAxis: {
        type: 'value',
        minInterval: 1,
        axisLabel: axisLabel(c),
        splitLine: splitLine(c)
      },
      series: [
        {
          name: '我回复',
          type: 'bar',
          stack: 'hours',
          barMaxWidth: 14,
          data: hours.map((h) => h.outbound),
          itemStyle: { color: c.brand, borderRadius: [0, 0, 3, 3] }
        },
        {
          name: '客户发',
          type: 'bar',
          stack: 'hours',
          barMaxWidth: 14,
          data: hours.map((h) => h.inbound),
          itemStyle: { color: c.blue, borderRadius: [3, 3, 0, 0] }
        }
      ]
    }
  }, [hours, c])
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
  const c = useChartTheme()
  const option = useMemo<EChartsOption>(() => {
    return {
      animationDuration: 300,
      grid: { left: 8, right: 8, top: 26, bottom: 0, containLabel: true },
      tooltip: { trigger: 'axis', confine: true, axisPointer: { type: 'shadow' } },
      legend: { ...legendBase(c), data: ['成功', '失败/拦截'] },
      xAxis: {
        type: 'category',
        data: stats.map((d) => d.day),
        axisTick: { show: false },
        axisLine: { lineStyle: axisLine(c) },
        axisLabel: axisLabel(c)
      },
      yAxis: {
        type: 'value',
        minInterval: 1,
        axisLabel: axisLabel(c),
        splitLine: splitLine(c)
      },
      series: [
        {
          name: '成功',
          type: 'bar',
          stack: 'send',
          barMaxWidth: 26,
          data: stats.map((d) => d.sent),
          itemStyle: { color: c.brand, borderRadius: [0, 0, 4, 4] }
        },
        {
          name: '失败/拦截',
          type: 'bar',
          stack: 'send',
          barMaxWidth: 26,
          data: stats.map((d) => d.failed),
          itemStyle: { color: c.danger, borderRadius: [4, 4, 0, 0] }
        }
      ]
    }
  }, [stats, c])
  return <EChart option={option} height={150} />
}

/** 消息类型分布 Top（横向进度条） */
function OpsTypes({ items }: { items: OpsTypeCount[] }): React.JSX.Element {
  if (items.length === 0)
    return <DbEmpty title="范围内暂无消息" desc="所选区间内还没有消息记录。" />
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
          <span className="db-type-count ui-num">{t.count}</span>
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
  // 图表配色跟随主题：useChartTheme 在切主题时返回新的一份 → option/分类色一起重建
  const chartTheme = useChartTheme()
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
              { name: '群聊', value: groupMsg, color: chartTheme.blue },
              { name: '私聊/个人', value: privateMsg, color: chartTheme.brand }
            ],
            `${opsShare}%`,
            '群消息占比',
            chartTheme
          )
        : null,
    [groupMsg, privateMsg, opsTotal, opsShare, chartTheme]
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

  // useMemo:否则每次渲染都是新数组引用,下面 compDonut 的 memo 永不命中 →
  // EChart 每次 setOption(notMerge) 整图重建并重播动画
  const compSegs = useMemo<CompSegment[]>(
    () =>
      [
        { key: 'person', label: '个人', color: chartTheme.brand, n: comp.person },
        { key: 'group', label: '群聊', color: chartTheme.blue, n: comp.group },
        { key: 'official', label: '公众号', color: chartTheme.amber, n: comp.official },
        { key: 'fold', label: '折叠聊天', color: chartTheme.palette[6], n: comp.fold }
      ].filter((s) => s.n > 0),
    [comp, chartTheme]
  )
  const compTotal = useMemo(() => compSegs.reduce((sum, s) => sum + s.n, 0), [compSegs])
  const compDonut = useMemo<EChartsOption | null>(
    () =>
      compTotal > 0
        ? donutOption(
            compSegs.map((s) => ({ name: s.label, value: s.n, color: s.color })),
            String(compTotal),
            '会话',
            chartTheme
          )
        : null,
    [compSegs, compTotal, chartTheme]
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
  const todayActive = useMemo(
    () =>
      sessions.filter(
        (s) =>
          !s.isOfficialAccount &&
          !s.isFoldGroup &&
          s.lastTimestamp >= todayStart &&
          s.lastTimestamp <= nowMs
      ).length,
    [sessions, todayStart, nowMs]
  )

  // ── 发送监控（真实 send_log）──
  const totals = overview?.totals ?? {}
  const verifiedRate = overview?.verifiedRate ?? null
  const verifiedPct = verifiedRate === null ? null : Math.round(verifiedRate * 100)

  const hasSends = sendStats.some((d) => d.sent + d.failed > 0)
  const sendRatio = sendStatus
    ? Math.min(100, Math.round((sendStatus.todayCount / Math.max(sendStatus.dailyLimit, 1)) * 100))
    : 0

  return (
    <div className="db-page">
      {/* 页面标题与页签由 MonitorShell 提供；本页的口径脚注留在页尾。注意别用 .db-panel——那是卡片样式 */}

      {sendStatus?.halted && (
        <div className="db-alert">
          发送通道已熔断（连续校验失败），自动/人工发送均已暂停，请到「设置」页检查并复位。
        </div>
      )}

      {/* 顶部运营指标：一条 HUD 读数带（数字等宽；警示态只在有值时染淡底） */}
      <div className="page-card db-hud">
        <div className="db-hud-cell">
          <div className="db-hud-label">
            <span className="db-hud-dot" aria-hidden="true" />
            总会话数
          </div>
          <div className="db-hud-value ui-num">{sessions.length}</div>
          <div className="db-hud-hint">微信库会话</div>
        </div>
        <div className={`db-hud-cell tone-warn${needReply > 0 ? ' is-hot' : ''}`}>
          <div className="db-hud-label">
            <span className="db-hud-dot" aria-hidden="true" />
            待回复会话
          </div>
          <div className="db-hud-value ui-num">{needReply}</div>
          <div className="db-hud-hint">有未读 · 最后一条为客户</div>
        </div>
        <div className={`db-hud-cell tone-danger${overdueCount > 0 ? ' is-hot' : ''}`}>
          <div className="db-hud-label">
            <span className="db-hud-dot" aria-hidden="true" />
            超时未回
          </div>
          <div className="db-hud-value ui-num">{overdueCount}</div>
          <div className="db-hud-hint">超过 2 小时未回</div>
        </div>
        <div className="db-hud-cell">
          <div className="db-hud-label">
            <span className="db-hud-dot" aria-hidden="true" />
            今日互动会话
          </div>
          <div className="db-hud-value ui-num">{todayActive}</div>
          <div className="db-hud-hint">今日有消息的会话</div>
        </div>
        <div className="db-hud-cell">
          <div className="db-hud-label">
            <span className="db-hud-dot" aria-hidden="true" />
            今日已发送
          </div>
          <div className="db-hud-value ui-num">{sendStatus?.todayCount ?? '—'}</div>
          <div className="db-hud-hint">
            {sendStatus ? `上限 ${sendStatus.dailyLimit} / 日` : '本地发送审计 send_log'}
          </div>
        </div>
      </div>

      <div className="page-card db-panel db-queue-panel">
        <div className="db-panel-head">
          <span className="db-panel-title">待回复队列</span>
          {needReply > 0 && <span className="ui-chip is-sm is-bad ui-num">{needReply}</span>}
          <span className="db-panel-note">按最后消息时间升序 · 越久越靠前</span>
        </div>
        {followUps.length === 0 ? (
          <DbEmpty
            glyph
            title="暂无待回复会话"
            desc="有未读且最后一条为客户消息的会话会出现在这里，全部跟进完毕。"
          />
        ) : (
          <div className="db-q-scroll">
            {followUps.slice(0, QUEUE_SHOW).map((s) => {
              const overdue = nowMs > 0 && nowMs - s.lastTimestamp > OVERDUE_MS
              return (
                <div
                  key={s.username}
                  className="db-q-item"
                  role="button"
                  tabIndex={0}
                  onClick={() => source === 'wx' && gotoSession(s.username)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      if (source === 'wx') gotoSession(s.username)
                    }
                  }}
                >
                  <span className="cu-avatar" style={{ background: avatarColor(s.displayName) }}>
                    {s.displayName.slice(0, 1)}
                  </span>
                  <div className="db-q-main">
                    <div className="db-q-name">
                      <span className="db-q-name-text">{s.displayName}</span>
                      {s.unreadCount > 0 && (
                        <span className="db-q-badge ui-num">{s.unreadCount}</span>
                      )}
                    </div>
                    <div className="db-q-sub">{s.summary}</div>
                  </div>
                  <span className={`db-q-time ui-num${overdue ? ' is-overdue' : ''}`}>
                    {fmtStamp(s.lastTimestamp)}
                    <span className="db-q-age">（{fmtAge(nowMs, s.lastTimestamp)}）</span>
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

      <div className="db-grid">
        <div className="page-card db-panel">
          <div className="db-panel-head">
            <span className="db-panel-title">会话构成</span>
            <span className="db-panel-note">按会话类型标记</span>
          </div>
          {compTotal === 0 ? (
            <DbEmpty
              glyph
              title="暂无会话数据"
              desc={
                source === 'wx'
                  ? '微信库里还没有会话，稍后会自动刷新。'
                  : '连接微信数据后展示会话构成与置顶 / 折叠统计。'
              }
            />
          ) : compDonut ? (
            <>
              <EChart option={compDonut} height={190} />
              {(comp.pinned > 0 || comp.collapsed > 0) && (
                <div className="db-comp-note">
                  置顶 <span className="ui-num">{comp.pinned}</span> · 折叠{' '}
                  <span className="ui-num">{comp.collapsed}</span>
                </div>
              )}
            </>
          ) : null}
        </div>

        <div className="page-card db-panel">
          <div className="db-panel-head">
            <span className="db-panel-title">发送监控</span>
            <span className="db-panel-note">近 7 日 · send_log</span>
          </div>
          <div className="db-freq">
            <div className="db-freq-row">
              <span>今日频控</span>
              <span className="ui-num">
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
            <DbEmpty title="暂无发送记录" desc="人工 / 自动发送后会在这里汇总成功率与被拦截数。" />
          ) : (
            <SendBarChart stats={sendStats} />
          )}
        </div>
      </div>

      {/* 消息运营洞察（真实微信消息库聚合） */}
      <div className="db-sec">
        <div className="db-sec-head">
          <span className="ui-label">消息运营洞察</span>
          <span className="ui-chip is-sm is-warn">真实微信消息库</span>
          <span className="db-sec-spacer" />
          {source === 'wx' && (
            <span className="ui-seg">
              <button
                type="button"
                className={`ui-seg-btn${range === 7 ? ' is-on' : ''}`}
                onClick={() => setRange(7)}
              >
                近 7 日
              </button>
              <button
                type="button"
                className={`ui-seg-btn${range === 30 ? ' is-on' : ''}`}
                onClick={() => setRange(30)}
              >
                近 30 日
              </button>
            </span>
          )}
        </div>

        {source !== 'wx' ? (
          <div className="page-card db-panel db-panel-gate">
            <ConnectGuide
              what="消息运营洞察（收发趋势 / 时段分布 / 消息类型 / 响应时效）"
              detail="看板上半部分的发送统计与质量来自本地审计，可直接使用；消息级洞察需要连接微信数据后聚合。"
            />
          </div>
        ) : !opsReady ? (
          <div className="page-card db-panel">
            <DbEmpty
              glyph
              title={opsMsg ? '消息统计暂时不可用' : '正在聚合消息统计…'}
              desc={opsMsg ?? '首次加载会扫描所选区间的微信消息库，通常几秒内完成。'}
            />
          </div>
        ) : ops ? (
          <>
            <div className="db-grid">
              <div className="page-card db-panel">
                <div className="db-panel-head">
                  <span className="db-panel-title">每日收发趋势</span>
                  <span className="db-panel-note">近 {ops.range} 日 · 按日</span>
                </div>
                <OpsTrend points={ops.trend} />
              </div>
              <div className="page-card db-panel">
                <div className="db-panel-head">
                  <span className="db-panel-title">24 小时时段分布</span>
                  <span className="db-panel-note">按小时</span>
                </div>
                <OpsHours hours={ops.hours} />
              </div>
            </div>

            <div className="db-grid">
              <div className="page-card db-panel">
                <div className="db-panel-head">
                  <span className="db-panel-title">消息类型分布</span>
                  <span className="db-panel-note">Top 8</span>
                </div>
                <OpsTypes items={ops.typeDist} />
              </div>
              <div className="page-card db-panel">
                <div className="db-panel-head">
                  <span className="db-panel-title">群聊 / 私聊分布</span>
                  <span className="db-panel-note">按消息条数</span>
                </div>
                {opsTotal === 0 ? (
                  <DbEmpty title="范围内暂无消息" desc="切换时间范围或等待新消息产生。" />
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
            <div className="db-panel-head">
              <span className="db-panel-title">发送质量</span>
              <span className="db-panel-note">近 7 日 · send_log</span>
            </div>
            <div className="db-freq">
              {Object.keys(totals).length === 0 ? (
                <DbEmpty title="暂无发送记录" desc="近 7 日没有发送审计数据。" />
              ) : (
                <>
                  <div className="db-freq-row">
                    <span>闭环校验通过率</span>
                    <span className="ui-num">{verifiedPct === null ? '—' : `${verifiedPct}%`}</span>
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
                        <span key={k} className={`ui-chip is-sm is-${RESULT_TONE[k] ?? 'warn'}`}>
                          {label} <span className="ui-num">{totals[k]}</span>
                        </span>
                      ))}
                  </div>
                </>
              )}
            </div>
            <div className="db-panel-sub">失败原因 Top</div>
            {overview && overview.failReasons.length === 0 ? (
              <div className="db-empty-line">近 7 日无失败记录</div>
            ) : (
              <div className="db-reasons">
                {(overview?.failReasons ?? []).map((rr, i) => (
                  <div className="db-reason" key={i}>
                    <span className="db-reason-name">
                      <span className="ui-num">{i + 1}.</span> {rr.reason}
                    </span>
                    <span className="db-reason-count ui-num">{rr.count}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="page-card db-panel">
            <div className="db-panel-head">
              <span className="db-panel-title">服务响应时效</span>
              <span className="db-panel-note">客户先发 → 我回复</span>
            </div>
            {source !== 'wx' ? (
              <DbEmpty
                title="连接微信数据后展示"
                desc="响应时效基于微信消息库里的真实回复间隔计算。"
              />
            ) : !opsReady ? (
              <DbEmpty
                title={opsMsg ? '消息统计暂时不可用' : '正在聚合消息统计…'}
                desc={opsMsg ?? '加载完成后展示 30 分钟 / 2 小时的回复占比。'}
              />
            ) : resp && resp.samples > 0 ? (
              <div className="db-freq db-freq-narrow">
                <div className="db-freq-row">
                  <span>有效样本</span>
                  <span className="ui-num">{resp.samples} 次回复</span>
                </div>
                <div className="db-freq-row">
                  <span>30 分钟内回复</span>
                  <span className="ui-num">{r30}%</span>
                </div>
                <div className="db-freq-bar">
                  <div className="db-freq-fill" style={{ width: `${r30}%` }} />
                </div>
                <div className="db-freq-row">
                  <span>2 小时内回复</span>
                  <span className="ui-num">{r2h}%</span>
                </div>
                <div className="db-freq-bar">
                  <div className="db-freq-fill" style={{ width: `${r2h}%` }} />
                </div>
                <div className="db-freq-row">
                  <span>中位响应时长</span>
                  <span className="ui-num">
                    {resp.medianMinutes === null ? '—' : `${resp.medianMinutes} 分钟`}
                  </span>
                </div>
                <div className="db-freq-row">
                  <span>超 2h 未回待跟进</span>
                  <span className={`ui-num${resp.noResponse > 0 ? ' db-text-warn' : ''}`}>
                    {resp.noResponse}
                  </span>
                </div>
              </div>
            ) : (
              <DbEmpty
                title="缺少可结算的回复样本"
                desc="范围内没有「客户先发 → 我回复」的会话。"
              />
            )}
          </div>
        </div>
      </div>

      <div className="page-subtitle db-footnote">
        口径：待回复=有未读且最后一条为客户消息（不含公众号/折叠）；超时未回=有未读且最后消息距今超
        2 小时；今日互动=今日有消息的会话；沉睡=近 7~30 天未联系的个人会话。
      </div>
    </div>
  )
}

export default DashboardPage
