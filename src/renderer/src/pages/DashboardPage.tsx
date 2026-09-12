import { useEffect, useMemo, useState } from 'react'
import { useWorkbenchStore } from '../stores/workbench'
import { avatarColor } from '../lib/ui'
import { fmtStamp } from '../../../shared/monitorMetrics'
import EChart from '../components/EChart'
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
import type { GrowthOverview } from '../../../shared/growth'
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
  /** 营销板块概览(素材/拆解/爆改/发布回填) */
  const [growthOv, setGrowthOv] = useState<GrowthOverview | null>(null)

  useEffect(() => {
    const api = window.api?.cs?.growth
    if (!api?.overview) return
    let alive = true
    void api.overview().then((res) => {
      if (alive && res.ok && res.overview) setGrowthOv(res.overview)
    })
    return () => {
      alive = false
    }
  }, [])

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

  // useMemo:否则每次渲染都是新数组引用,下面 compDonut 的 memo 永不命中 →
  // EChart 每次 setOption(notMerge) 整图重建并重播动画
  const compSegs = useMemo<CompSegment[]>(
    () =>
      [
        { key: 'person', label: '个人', color: CHART_GREEN, n: comp.person },
        { key: 'group', label: '群聊', color: CHART_BLUE, n: comp.group },
        { key: 'official', label: '公众号', color: CHART_AMBER, n: comp.official },
        { key: 'fold', label: '折叠聊天', color: '#e4e6eb', n: comp.fold }
      ].filter((s) => s.n > 0),
    [comp]
  )
  const compTotal = useMemo(() => compSegs.reduce((sum, s) => sum + s.n, 0), [compSegs])
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

      {growthOv ? (
        <div className="page-card db-panel">
          <div className="db-panel-title">
            营销内容效果
            <span className="db-panel-hint">营销板块</span>
          </div>
          <div className="db-panel-sub">
            素材 {growthOv.contentCount} · 已拆解 {growthOv.decompCount} · 爆改产出{' '}
            {growthOv.remixOutputCount} · 已发布素材 {growthOv.publishedContentCount} · 新客线索{' '}
            {growthOv.totalLeads} · 回填金额 ¥{growthOv.totalAmount}
          </div>
          {growthOv.recentMetrics.length > 0 ? (
            <div style={{ marginTop: 10, fontSize: 13, color: 'var(--text-2)' }}>
              {growthOv.recentMetrics.slice(0, 5).map((m) => (
                <div
                  key={m.id}
                  style={{ display: 'flex', gap: 12, padding: '4px 0', alignItems: 'baseline' }}
                >
                  <span style={{ color: 'var(--text-3)', fontSize: 12, flex: 'none' }}>
                    {fmtStamp(m.capturedAt)}（{fmtAge(nowMs, m.capturedAt)}）
                  </span>
                  <span style={{ flex: 'none' }}>{m.channel}</span>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {m.contentTitle || '(素材已删除)'}
                  </span>
                  <span style={{ flex: 'none' }}>
                    线索 {m.leads} · ¥{m.amount}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="db-panel-sub">
              还没有发布登记; 在营销板块的素材详情里「登记发布」后会出现在这里
            </div>
          )}
        </div>
      ) : null}

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
                      {s.unreadCount > 0 && <span className="db-q-badge">{s.unreadCount}</span>}
                    </div>
                    <div className="db-q-sub">{s.summary}</div>
                  </div>
                  <span className={`db-q-time${overdue ? ' is-overdue' : ''}`}>
                    {fmtStamp(s.lastTimestamp)}（{fmtAge(nowMs, s.lastTimestamp)}）
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
        口径：待回复=有未读且最后一条为客户消息（不含公众号/折叠）；超时未回=有未读且最后消息距今超
        2 小时；今日互动=今日有消息的会话；沉睡=近 7~30 天未联系的个人会话。
      </div>
    </div>
  )
}

export default DashboardPage
