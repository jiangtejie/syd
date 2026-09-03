import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkbenchStore } from '../stores/workbench'
import { toast } from '../stores/toast'
import EChart from '../components/EChart'
import type { EChartsOption } from 'echarts'
import {
  computeMonitorData,
  fmtTimeShort,
  ageText
} from '../lib/monitorMetrics'
import type {
  FeedbackIssue,
  FeedbackIssueDetail,
  FeedbackIssueStatus,
  FeedbackIssueType
} from '../../../shared/types'
import './monitor.css'

/**
 * 问题监控中心(管理者视角 BI + Bug 追踪):
 * KPI 大卡 → 趋势/类型/群榜/积压年龄图表 → 钻取追踪列表(状态处置/时间线/定位聊天)。
 * 数据源:本地 issue 库(cs:issue:list/detail/setStatus),无新增后端聚合。
 */

type StatusFilter = 'open' | 'done' | 'stalled' | 'archived' | 'all'
const TYPE_OPTIONS: FeedbackIssueType[] = ['客诉', '售后', '物流', '价格', '咨询', '建议', '其他']

const RANGE_OPTIONS = [7, 14, 30]

const STATUS_CHIP: Record<FeedbackIssueStatus, { label: string; cls: string }> = {
  open: { label: '待处理', cls: 'is-open' },
  done: { label: '已解决', cls: 'is-done' },
  stalled: { label: '已搁置', cls: 'is-stalled' },
  archived: { label: '已归档', cls: 'is-archived' }
}

function statusChip(it: FeedbackIssue): { label: string; cls: string } {
  if (it.status === 'open') {
    if (it.followUp) {
      return {
        label: it.followUpOverdue ? '跟进超时' : '跟进中',
        cls: it.followUpOverdue ? 'is-overdue' : 'is-follow'
      }
    }
    return { label: '待处理', cls: 'is-open' }
  }
  if (it.status === 'done' && it.autoDone) {
    return { label: '自动解决', cls: 'is-auto' }
  }
  return STATUS_CHIP[it.status]
}

const BRAND = '#07c160'
const PALETTE = ['#fa5151', '#f5a623', '#07c160', '#3c82f6', '#8e5cf0', '#00b8a9', '#c0c4cc']

function KpiCard({
  label,
  value,
  hint,
  tone
}: {
  label: string
  value: string | number
  hint?: string
  tone?: 'danger' | 'warn' | 'ok'
}): React.JSX.Element {
  return (
    <div className={`mon-kpi${tone ? ` tone-${tone}` : ''}`}>
      <div className="mon-kpi-label">{label}</div>
      <div className="mon-kpi-value">{value}</div>
      {hint && <div className="mon-kpi-hint">{hint}</div>}
    </div>
  )
}

/** 单条问题状态处置按钮组 */
function IssueActions({
  issue,
  onSet
}: {
  issue: FeedbackIssue | FeedbackIssueDetail
  onSet: (status: FeedbackIssueStatus) => void
}): React.JSX.Element {
  const st = issue.status
  return (
    <div className="mon-actions">
      {(st === 'open' || st === 'stalled') && (
        <button type="button" className="mon-btn primary" onClick={() => onSet('done')}>
          ✓ 标记已解决
        </button>
      )}
      {st === 'open' && (
        <>
          <button type="button" className="mon-btn" onClick={() => onSet('stalled')}>
            暂搁置
          </button>
          <button type="button" className="mon-btn" onClick={() => onSet('archived')} title="误报/无需处理,归档后不再提醒">
            不是问题
          </button>
        </>
      )}
      {st !== 'open' && (
        <button type="button" className="mon-btn" onClick={() => onSet('open')}>
          ↺ 重新打开
        </button>
      )}
    </div>
  )
}

function MonitorPage(): React.JSX.Element {
  const wxid = useWorkbenchStore((s) => s.wxid)
  const source = useWorkbenchStore((s) => s.source)
  const gotoSession = useWorkbenchStore((s) => s.gotoSession)
  const connected = !!wxid && source === 'wx' && wxid !== 'wxid_demo'
  const issueApi = window.api?.cs?.issue

  const [issues, setIssues] = useState<FeedbackIssue[]>([])
  const [loading, setLoading] = useState(false)
  const [range, setRange] = useState(7)
  // 筛选与钻取
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open')
  const [typeFilter, setTypeFilter] = useState<'all' | FeedbackIssueType>('all')
  const [groupFilter, setGroupFilter] = useState('')
  const [keyword, setKeyword] = useState('')
  const [visible, setVisible] = useState(40)
  // 追踪抽屉
  const [active, setActive] = useState<FeedbackIssue | null>(null)
  const [detail, setDetail] = useState<FeedbackIssueDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const detailSeqRef = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    if (!connected || !issueApi) return
    setLoading(true)
    try {
      const res = await issueApi.list(wxid!)
      if (res.ok && res.issues) {
        setIssues(res.issues as FeedbackIssue[])
      } else {
        toast.error((res as { error?: string }).error || '读取问题失败')
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '读取问题失败')
    } finally {
      setLoading(false)
    }
  }, [connected, wxid, issueApi])

  useEffect(() => {
    void load()
  }, [load])

  const metrics = useMemo(() => computeMonitorData(issues, range), [issues, range])

  const filtered = useMemo(() => {
    let list = issues
    if (statusFilter === 'open') list = list.filter((i) => i.status === 'open')
    else if (statusFilter !== 'all') list = list.filter((i) => i.status === statusFilter)
    if (typeFilter !== 'all') list = list.filter((i) => i.type === typeFilter)
    if (groupFilter) list = list.filter((i) => i.groupUsername === groupFilter)
    if (keyword.trim()) {
      const k = keyword.trim().toLowerCase()
      list = list.filter(
        (i) => i.title.toLowerCase().includes(k) || (i.summary ?? '').toLowerCase().includes(k)
      )
    }
    return list
  }, [issues, statusFilter, typeFilter, groupFilter, keyword])

  // 状态处置:乐观更新 + 回写,成功同步刷新
  const applyStatus = useCallback(
    async (id: number, status: FeedbackIssueStatus): Promise<void> => {
      setIssues((prev) => prev.map((it) => (it.id === id ? { ...it, status } : it)))
      setDetail((prev) => (prev && prev.id === id ? { ...prev, status } : prev))
      const res = await issueApi?.setStatus(id, status).catch(() => null)
      if (!res?.ok) {
        toast.error((res as { error?: string } | null)?.error || '状态更新失败')
        void load()
      }
    },
    [issueApi, load]
  )

  const openDetail = async (it: FeedbackIssue): Promise<void> => {
    setActive(it)
    const seq = ++detailSeqRef.current
    setDetailLoading(true)
    setDetail(null)
    const res = await issueApi?.detail(it.id).catch(() => null)
    if (seq !== detailSeqRef.current) return
    if (res?.ok && res.issue) setDetail(res.issue as FeedbackIssueDetail)
    setDetailLoading(false)
  }
  // 图表配置
const trendOption = useMemo<EChartsOption>(() => {
    return {
      tooltip: { trigger: 'axis' },
      legend: { data: ['新增', '解决'], top: 0, right: 0, textStyle: { fontSize: 11 } },
      grid: { left: 8, right: 8, top: 26, bottom: 0, containLabel: true },
      xAxis: { type: 'category', data: metrics.trend.map((t) => t.day), axisLabel: { fontSize: 10 } },
      yAxis: { type: 'value', minInterval: 1, axisLabel: { fontSize: 10 } },
      series: [
        { name: '新增', type: 'bar', data: metrics.trend.map((t) => t.created), itemStyle: { color: '#fa8a8a' }, barMaxWidth: 14 },
        { name: '解决', type: 'line', data: metrics.trend.map((t) => t.resolved), itemStyle: { color: BRAND }, lineStyle: { width: 2 } }
      ]
    }
  }, [metrics])

  const typeOption = useMemo<EChartsOption>(() => {
    const total = metrics.typeOpen.reduce((n, x) => n + x.value, 0)
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {c}（{d}%）' },
      legend: { bottom: 0, textStyle: { fontSize: 10 } },
      series: [
        {
          type: 'pie',
          radius: ['42%', '66%'],
          center: ['50%', '44%'],
          avoidLabelOverlap: true,
          itemStyle: { borderRadius: 4, borderColor: '#fff', borderWidth: 1 },
          label: { show: false },
          data: metrics.typeOpen.map((x, i) => ({ name: x.name, value: x.value, itemStyle: { color: PALETTE[i % PALETTE.length] } }))
        }
      ],
      graphic: [
        {
          type: 'text',
          left: 'center',
          top: '34%',
          style: { text: String(total), fontSize: 20, fontWeight: 700, fill: '#1f2329', textAlign: 'center' },
          z: 10
        },
        {
          type: 'text',
          left: 'center',
          top: '52%',
          style: { text: '待处理', fontSize: 10, fill: '#999', textAlign: 'center' },
          z: 10
        }
      ]
    }
  }, [metrics])

  const groupOption = useMemo<EChartsOption>(() => {
    const rows = [...metrics.groupTop].reverse()
    return {
      tooltip: { trigger: 'item' },
      grid: { left: 8, right: 30, top: 4, bottom: 0, containLabel: true },
      xAxis: { type: 'value', minInterval: 1, axisLabel: { fontSize: 10 } },
      yAxis: {
        type: 'category',
        data: rows.map((g) => (g.name.length > 14 ? g.name.slice(0, 14) + '…' : g.name)),
        axisLabel: { fontSize: 10 }
      },
      series: [
        {
          type: 'bar',
          data: rows.map((g, i) => ({
            value: g.value,
            itemStyle: { color: i === rows.length - 1 ? BRAND : '#7fd8ad' }
          })),
          barMaxWidth: 12
        }
      ]
    }
  }, [metrics])

  const ageOption = useMemo<EChartsOption>(() => {
    const colors = ['#3c82f6', '#f5a623', '#f08a24', '#fa5151']
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { left: 8, right: 8, top: 20, bottom: 0, containLabel: true },
      xAxis: { type: 'category', data: metrics.age.map((a) => a.label), axisLabel: { fontSize: 10 } },
      yAxis: { type: 'value', minInterval: 1, axisLabel: { fontSize: 10 } },
      series: [
        {
          type: 'bar',
          data: metrics.age.map((a, i) => ({ value: a.value, itemStyle: { color: colors[i] } })),
          barMaxWidth: 34,
          label: { show: true, position: 'top', fontSize: 10 }
        }
      ]
    }
  }, [metrics])

  const visibleList = filtered.slice(0, visible)

  return (
    <div className="page-scroll mon-page">
      <div className="mon-head">
        <h2 className="page-title">问题监控</h2>
        <div className="mon-toolbar">
          <select
            className="mon-select"
            value={range}
            onChange={(e) => setRange(Number(e.target.value))}
            title="趋势统计窗口"
          >
            {RANGE_OPTIONS.map((d) => (
              <option key={d} value={d}>
                近 {d} 天趋势
              </option>
            ))}
          </select>
          <button type="button" className="mon-btn ghost" disabled={loading} onClick={() => void load()}>
            {loading ? '刷新中…' : '刷新'}
          </button>
        </div>
      </div>

      {!connected ? (
        <div className="mon-empty">
          尚未连接微信:请先到 设置 → 微信数据与密钥 连接账号;本地已有人工处理的问题也会展示。
        </div>
      ) : (
        <>
          {/* KPI 大卡 */}
          <div className="mon-kpis">
            <KpiCard label="待处理(未回复)" value={metrics.kpis.pending} tone="danger" />
            <KpiCard label="跟进中" value={metrics.kpis.following} hint="客服已回复未闭环" tone="warn" />
            <KpiCard label="跟进超时" value={metrics.kpis.followOverdue} hint="回复后超 12h 无下文" tone="danger" />
            <KpiCard label="积压超时" value={metrics.kpis.backlog48} hint="首现超 48h 未闭环" tone="warn" />
            <KpiCard label="今日新增" value={metrics.kpis.createdToday} />
            <KpiCard label="今日解决" value={metrics.kpis.resolvedToday} tone="ok" />
            <KpiCard
              label="闭环率(累计)"
              value={metrics.kpis.closedRate === null ? '—' : `${metrics.kpis.closedRate}%`}
              hint="已解决 ÷ 全部非归档"
              tone="ok"
            />
          </div>

          {/* 图表区 */}
          <div className="mon-charts">
            <div className="mon-card mon-trend">
              <div className="mon-card-title">新增 / 解决趋势</div>
              <EChart option={trendOption} height={190} />
            </div>
            <div className="mon-card mon-pie">
              <div className="mon-card-title">待处理类型分布</div>
              <EChart option={typeOption} height={190} />
            </div>
            <div className="mon-card mon-groups">
              <div className="mon-card-title">问题最多的群(Top10 · 下拉可钻取)</div>
              <EChart
                option={groupOption}
                height={Math.max(120, metrics.groupTop.length * 20 + 40)}
              />
            </div>
            <div className="mon-card mon-age">
              <div className="mon-card-title">积压年龄分布</div>
              <EChart option={ageOption} height={190} />
            </div>
          </div>

          {/* 钻取列表 + 追踪抽屉 */}
          <div className="mon-bottom">
            <div className="mon-card mon-list-card">
              <div className="mon-filter-bar">
                <select
                  className="mon-select"
                  value={statusFilter}
                  onChange={(e) => {
                    setStatusFilter(e.target.value as StatusFilter)
                    setVisible(40)
                  }}
                >
                  <option value="open">只看待处理/跟进中</option>
                  <option value="all">全部状态</option>
                  <option value="done">已解决</option>
                  <option value="stalled">已搁置</option>
                  <option value="archived">已归档</option>
                </select>
                <select
                  className="mon-select"
                  value={typeFilter}
                  onChange={(e) => {
                    setTypeFilter(e.target.value as 'all' | FeedbackIssueType)
                    setVisible(40)
                  }}
                >
                  <option value="all">全部类型</option>
                  {TYPE_OPTIONS.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <select
                  className="mon-select"
                  value={groupFilter}
                  onChange={(e) => {
                    setGroupFilter(e.target.value)
                    setVisible(40)
                  }}
                >
                  <option value="">全部群</option>
                  {metrics.groupTop.map((g) => (
                    <option key={g.username} value={g.username}>
                      {g.name}
                    </option>
                  ))}
                </select>
                <input
                  className="mon-input"
                  placeholder="搜索标题/摘要…"
                  value={keyword}
                  onChange={(e) => {
                    setKeyword(e.target.value)
                    setVisible(40)
                  }}
                />
                <span className="mon-count">
                  共 {filtered.length} 条{groupFilter ? '（已按群钻取）' : ''}
                </span>
              </div>

              {visibleList.length === 0 && (
                <div className="mon-empty">没有符合条件的问题{loading ? '（加载中…）' : ''}</div>
              )}
              {visibleList.map((it) => {
                const chip = statusChip(it)
                const isOld = it.status === 'open' && Date.now() - it.occurAt > 48 * 3600_000
                return (
                  <div
                    key={it.id}
                    className={`mon-row${active?.id === it.id ? ' is-active' : ''}`}
                    onClick={() => void openDetail(it)}
                  >
                    <span className={`mon-st ${chip.cls}`}>{chip.label}</span>
                    <span className="mon-row-type">{it.type}</span>
                    <span className="mon-row-main">
                      <span className="mon-row-title">{it.title}</span>
                      <span className="mon-row-sub">
                        {it.groupName || it.groupUsername} · {fmtTimeShort(it.occurAt)} · 证据{' '}
                        {it.msgCount} 条{it.autoDone ? ' · 自动' : ''}
                      </span>
                    </span>
                    <span className={`mon-row-age${isOld ? ' is-old' : ''}`}>
                      {it.status === 'open' ? ageText(it.occurAt) : ''}
                    </span>
                  </div>
                )
              })}
              {filtered.length > visible && (
                <button type="button" className="mon-more" onClick={() => setVisible((v) => v + 40)}>
                  加载更多（{filtered.length - visible}）
                </button>
              )}
            </div>

            {/* 追踪抽屉 */}
            {active && (
              <div className="mon-card mon-drawer">
                <div className="mon-drawer-head">
                  <span className={`mon-st ${statusChip(active).cls}`}>{statusChip(active).label}</span>
                  <span className="mon-row-type">{active.type}</span>
                  <button
                    type="button"
                    className="mon-x"
                    onClick={() => {
                      setActive(null)
                      setDetail(null)
                    }}
                  >
                    ✕
                  </button>
                </div>
                <div className="mon-drawer-title">{active.title}</div>
                <div className="mon-drawer-meta">
                  {active.groupName || active.groupUsername} · 首现 {fmtTimeShort(active.occurAt)}
                  {active.status === 'open' && <> · 已积压 {ageText(active.occurAt)}</>}
                </div>
                {active.summary && <div className="mon-drawer-summary">{active.summary}</div>}

                {detailLoading ? (
                  <div className="mon-drawer-empty">加载证据中…</div>
                ) : !detail ? (
                  <div className="mon-drawer-empty">无证据详情</div>
                ) : (
                  <div className="mon-drawer-tl">
                    {detail.related.map((m, i) => (
                      <div key={i} className={`mon-tl-item${m.isSend || m.senderIsTeam ? ' is-my' : ''}`}>
                        <span className="mon-tl-dot" />
                        <div className="mon-tl-body">
                          <div className="mon-tl-head">
                            <b>
                              {m.isSend ? `我方 · ${m.senderName}` : m.senderIsTeam ? `团队 · ${m.senderName}` : m.senderName}
                            </b>
                            <time>{fmtTimeShort(m.time)}</time>
                            {i === 0 && <em className="mon-tl-mark">首现</em>}
                            {i === detail.related.length - 1 && detail.related.length > 1 && (
                              <em className="mon-tl-mark">最新</em>
                            )}
                          </div>
                          <div className="mon-tl-text">{m.text || '[非文本消息]'}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="mon-drawer-foot">
                  <IssueActions issue={detail ?? active} onSet={(s) => void applyStatus(active.id, s)} />
                  <button
                    type="button"
                    className="mon-btn ghost"
                    onClick={() => {
                      if (wxid) {
                        gotoSession(active.groupUsername)
                      }
                    }}
                    title="跳到该群聊天并滚动定位"
                  >
                    ◎ 在聊天中定位
                  </button>
                </div>
                {active.autoDone && active.status === 'done' && (
                  <div className="mon-drawer-note">系统判定已闭环自动关闭,可重新打开复核</div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export default MonitorPage
