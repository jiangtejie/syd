import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkbenchStore } from '../stores/workbench'
import { toast } from '../stores/toast'
import EChart from '../components/EChart'
import type { EChartsOption } from 'echarts'
import { computeMonitorData, fmtTimeShort, ageText } from '../lib/monitorMetrics'
import type {
  FeedbackIssue,
  FeedbackIssueDetail,
  FeedbackIssueStatus,
  FeedbackIssueType,
  FeedbackAnalysisState,
  TeamMemberInfo
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
          <button
            type="button"
            className="mon-btn"
            onClick={() => onSet('archived')}
            title="误报/无需处理,归档后不再提醒"
          >
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
  // 口径配置(读取 app_config,默认 积压48h / 跟进超时12h)
  const [thresh, setThresh] = useState({ backlog: 48, followUp: 12 })
  // 追踪抽屉
  const [active, setActive] = useState<FeedbackIssue | null>(null)
  const [detail, setDetail] = useState<FeedbackIssueDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const detailSeqRef = useRef(0)
  // 分析管理(全量重析/清空/最近分析状态)
  const [anaBusy, setAnaBusy] = useState(false)
  const [anaState, setAnaState] = useState<FeedbackAnalysisState | null>(null)
  // 跟进人：团队成员(按账号作用域) + 微信联系人展示名回显(label 为空时)
  const [members, setMembers] = useState<TeamMemberInfo[]>([])
  const [memberNames, setMemberNames] = useState<Record<string, string>>({})
  const [ownerFilter, setOwnerFilter] = useState('')

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
      const st = await issueApi.state(wxid!)
      if (st.ok && st.state) setAnaState(st.state as FeedbackAnalysisState)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '读取问题失败')
    } finally {
      setLoading(false)
    }
  }, [connected, wxid, issueApi])

  // 团队成员加载（指派候选）；label 为空时用微信联系人备注/昵称回显
  const loadTeam = useCallback(async (): Promise<void> => {
    const teamApi = window.api?.cs?.team
    if (!connected || !teamApi) {
      setMembers([])
      return
    }
    const res = await teamApi.list(wxid!).catch(() => null)
    if (!res?.ok || !res.members) {
      setMembers([])
      return
    }
    const list = res.members as TeamMemberInfo[]
    setMembers(list)
    const needName = list.filter((m) => !(m.label ?? '').trim()).map((m) => m.username)
    setMemberNames({})
    if (needName.length > 0) {
      const namesApi = window.api?.cs?.wx?.contactNames
      const nr = namesApi ? await namesApi(wxid!, needName).catch(() => null) : null
      if (nr?.ok && nr.names) setMemberNames(nr.names)
    }
  }, [connected, wxid])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 进入页面异步加载(回调内 setState,全仓同款模式)
    void load()
    void loadTeam()
  }, [load, loadTeam])

  // 阈值读取(设置 → 偏好与数据 可配)
  useEffect(() => {
    const config = window.api?.cs?.config
    if (!config) return
    config
      .getAll()
      .then((all) => {
        const num = (v: string | undefined, fb: number): number => {
          const n = Number(v)
          return Number.isFinite(n) && n > 0 ? Math.floor(n) : fb
        }
        setThresh({
          backlog: num(all['monitor.backlogHours'], 48),
          followUp: num(all['monitor.followUpHours'], 12)
        })
      })
      .catch(() => undefined)
  }, [])

  // 数据变更自动刷新(主进程 cs:issue:changed 推送:任何页面处置/分析后同步)+ 窗口聚焦兜底
  useEffect(() => {
    let timer: number | null = null
    const unsub = issueApi?.onChanged?.(() => {
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = null
        void load()
      }, 250)
    })
    const onFocus = (): void => void load()
    window.addEventListener('focus', onFocus)
    return () => {
      if (timer !== null) window.clearTimeout(timer)
      unsub?.()
      window.removeEventListener('focus', onFocus)
    }
  }, [issueApi, load])

  const metrics = useMemo(
    () => computeMonitorData(issues, range, { backlogHours: thresh.backlog }),
    [issues, range, thresh.backlog]
  )

  const filtered = useMemo(() => {
    let list = issues
    if (statusFilter === 'open') list = list.filter((i) => i.status === 'open')
    else if (statusFilter !== 'all') list = list.filter((i) => i.status === statusFilter)
    if (typeFilter !== 'all') list = list.filter((i) => i.type === typeFilter)
    if (groupFilter) list = list.filter((i) => i.groupUsername === groupFilter)
    if (ownerFilter === '$none') list = list.filter((i) => !i.assignee)
    else if (ownerFilter) list = list.filter((i) => i.assignee === ownerFilter)
    if (keyword.trim()) {
      const k = keyword.trim().toLowerCase()
      list = list.filter(
        (i) => i.title.toLowerCase().includes(k) || (i.summary ?? '').toLowerCase().includes(k)
      )
    }
    return list
  }, [issues, statusFilter, typeFilter, groupFilter, ownerFilter, keyword])

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

  // 跟进人展示名：成员备注 label 优先，其次微信联系人备注/昵称，最后 username
  const ownerName = (username: string): string => {
    if (!username) return ''
    const m = members.find((x) => x.username === username)
    if (m && (m.label ?? '').trim()) return m.label ?? ''
    return memberNames[username] || username
  }

  // 指派/更换/取消跟进人：乐观更新(列表/抽屉/详情) + 回写，失败重载
  const applyAssignee = async (id: number, username: string): Promise<void> => {
    const owner = username || ''
    const assignee = owner || undefined
    setIssues((prev) => prev.map((it) => (it.id === id ? { ...it, assignee } : it)))
    setActive((prev) => (prev && prev.id === id ? { ...prev, assignee } : prev))
    setDetail((prev) => (prev && prev.id === id ? { ...prev, assignee } : prev))
    const res = await issueApi?.assign(id, owner || null).catch(() => null)
    if (!res?.ok) {
      toast.error((res as { error?: string } | null)?.error || '跟进人设置失败')
      void load()
    }
  }

  /** BI 快照导出(当前视野的 KPI/图表数据与问题清单,JSON) */ const exportSnapshot =
    async (): Promise<void> => {
      if (!connected || issues.length === 0) {
        toast.error('暂无可导出的监控数据')
        return
      }
      const r = await window.api?.cs?.dialog?.pickDirectory('选择快照保存目录')
      if (!r?.ok || !r.path) return
      const d = new Date()
      const pad = (n: number): string => String(n).padStart(2, '0')
      const name = `monitor_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
        d.getHours()
      )}${pad(d.getMinutes())}${pad(d.getSeconds())}.json`
      const payload = {
        app: 'wechat-cs-desktop',
        kind: 'monitor-snapshot',
        exportedAt: new Date().toISOString(),
        wxid,
        rangeDays: range,
        thresholdHours: thresh,
        kpis: metrics.kpis,
        trend: metrics.trend,
        typeOpen: metrics.typeOpen,
        groupTop: metrics.groupTop,
        age: metrics.age,
        issues: filtered.slice(0, 2000).map((i) => ({
          id: i.id,
          type: i.type,
          status: i.status,
          followUp: i.followUp,
          followUpOverdue: i.followUpOverdue,
          title: i.title,
          summary: i.summary ?? null,
          group: i.groupName || i.groupUsername,
          occurAt: i.occurAt,
          assignee: i.assignee ? ownerName(i.assignee) : null,
          msgCount: i.msgCount
        }))
      }
      const w = await window.api?.cs?.export?.writeFile(
        r.path,
        name,
        JSON.stringify(payload, null, 2)
      )
      if (w?.ok) toast.success(`快照已导出:${name}`)
      else toast.error(w?.error || '快照导出失败')
    }

  /** 全量重析(近 7 天全部活跃群;原看板维护操作迁移至此) */
  const runFullAnalyze = async (): Promise<void> => {
    if (!connected || !issueApi || anaBusy) return
    setAnaBusy(true)
    try {
      const res = await issueApi.analyze(wxid!)
      if (!res.ok) {
        toast.error((res as { error?: string }).error || '分析失败')
      } else {
        toast.success('全量分析完成,数据已更新')
        await load()
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '分析失败')
    } finally {
      setAnaBusy(false)
    }
  }

  /** 清空账号全部问题记录(含证据与历史,不可恢复) */
  const runClearAll = async (): Promise<void> => {
    if (!connected || !issueApi) return
    const ok = window.confirm(
      '将删除该账号的全部问题记录(含证据与历史,不可恢复)。确认清空?\n清空后可点「全量重析」从近 7 天群消息重新提取。'
    )
    if (!ok) return
    const res = await issueApi.clear(wxid!).catch(() => null)
    if (!res?.ok) {
      toast.error((res as { error?: string } | null)?.error || '清空失败')
      return
    }
    setIssues([])
    setActive(null)
    setDetail(null)
    setAnaState(null)
    toast.success('已清空全部问题记录')
  }
  // 图表配置
  const trendOption = useMemo<EChartsOption>(() => {
    return {
      tooltip: { trigger: 'axis' },
      legend: { data: ['新增', '解决'], top: 0, right: 0, textStyle: { fontSize: 11 } },
      grid: { left: 8, right: 8, top: 26, bottom: 0, containLabel: true },
      xAxis: {
        type: 'category',
        data: metrics.trend.map((t) => t.day),
        axisLabel: { fontSize: 10 }
      },
      yAxis: { type: 'value', minInterval: 1, axisLabel: { fontSize: 10 } },
      series: [
        {
          name: '新增',
          type: 'bar',
          data: metrics.trend.map((t) => t.created),
          itemStyle: { color: '#fa8a8a' },
          barMaxWidth: 14
        },
        {
          name: '解决',
          type: 'line',
          data: metrics.trend.map((t) => t.resolved),
          itemStyle: { color: BRAND },
          lineStyle: { width: 2 }
        }
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
          data: metrics.typeOpen.map((x, i) => ({
            name: x.name,
            value: x.value,
            itemStyle: { color: PALETTE[i % PALETTE.length] }
          }))
        }
      ],
      graphic: [
        {
          type: 'text',
          left: 'center',
          top: '34%',
          style: {
            text: String(total),
            fontSize: 20,
            fontWeight: 700,
            fill: '#1f2329',
            textAlign: 'center'
          },
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
      xAxis: {
        type: 'category',
        data: metrics.age.map((a) => a.label),
        axisLabel: { fontSize: 10 }
      },
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
          <button
            type="button"
            className="mon-btn ghost"
            disabled={loading}
            onClick={() => void load()}
          >
            {loading ? '刷新中…' : '刷新'}
          </button>
          <button
            type="button"
            className="mon-btn ghost"
            onClick={() => void exportSnapshot()}
            title="导出当前监控快照(KPI/图表/问题清单 JSON)"
          >
            导出快照
          </button>
          {anaState?.lastAt && (
            <span className="mon-ana-state" title={anaState.error || '最近一次全量分析状态'}>
              上次分析 {fmtTimeShort(anaState.lastAt)}
              {anaState.method === 'llm' ? ' · AI 提取' : ' · 规则提取'}
              {anaState.error ? ' · 上次失败' : ''}
            </span>
          )}
          <button
            type="button"
            className="mon-btn ghost"
            disabled={anaBusy || loading}
            onClick={() => void runFullAnalyze()}
            title="对全部活跃群按近 7 天重新分析提取(数据量大时较慢)"
          >
            {anaBusy ? '分析中…' : '全量重析'}
          </button>
          <button
            type="button"
            className="mon-btn danger"
            onClick={() => void runClearAll()}
            title="删除该账号全部问题记录(不可恢复)"
          >
            清空数据
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
            <KpiCard
              label="跟进中"
              value={metrics.kpis.following}
              hint="客服已回复未闭环"
              tone="warn"
            />
            <KpiCard
              label="跟进超时"
              value={metrics.kpis.followOverdue}
              hint={`回复后超 ${thresh.followUp}h 无下文`}
              tone="danger"
            />
            <KpiCard
              label="积压超时"
              value={metrics.kpis.backlog48}
              hint={`首现超 ${thresh.backlog}h 未闭环`}
              tone="warn"
            />
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
                <select
                  className="mon-select"
                  value={ownerFilter}
                  onChange={(e) => {
                    setOwnerFilter(e.target.value)
                    setVisible(40)
                  }}
                  title="按跟进人筛选"
                >
                  <option value="">全部跟进人</option>
                  <option value="$none">未指派</option>
                  {members.map((m) => (
                    <option key={m.username} value={m.username}>
                      {ownerName(m.username)}
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
                const isOld =
                  // eslint-disable-next-line -- 渲染中取当前时间仅用于积压标红(展示层,允许偶发非纯)
                  it.status === 'open' && Date.now() - it.occurAt > thresh.backlog * 3600_000
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
                    <span className="mon-row-owner">
                      <select
                        className="mon-owner-select"
                        value={it.assignee ?? ''}
                        aria-label="跟进人"
                        title={it.assignee ? `跟进人：${ownerName(it.assignee)}` : '指派跟进人'}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          e.stopPropagation()
                          void applyAssignee(it.id, e.target.value)
                        }}
                      >
                        <option value="">未指派</option>
                        {members.map((m) => (
                          <option key={m.username} value={m.username}>
                            {ownerName(m.username)}
                          </option>
                        ))}
                      </select>
                    </span>
                    <span className={`mon-row-age${isOld ? ' is-old' : ''}`}>
                      {it.status === 'open' ? ageText(it.occurAt) : ''}
                    </span>
                  </div>
                )
              })}
              {filtered.length > visible && (
                <button
                  type="button"
                  className="mon-more"
                  onClick={() => setVisible((v) => v + 40)}
                >
                  加载更多（{filtered.length - visible}）
                </button>
              )}
            </div>

            {/* 追踪抽屉 */}
            {active && (
              <div className="mon-card mon-drawer">
                <div className="mon-drawer-head">
                  <span className={`mon-st ${statusChip(active).cls}`}>
                    {statusChip(active).label}
                  </span>
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

                <div className="mon-drawer-owner">
                  <span className="mon-drawer-owner-label">跟进人</span>
                  <select
                    className="mon-select mon-owner-select-wide"
                    value={active.assignee ?? ''}
                    onChange={(e) => void applyAssignee(active.id, e.target.value)}
                    title="指派/更换跟进人（团队成员，空 = 取消指派）"
                  >
                    <option value="">未指派</option>
                    {members.map((m) => (
                      <option key={m.username} value={m.username}>
                        {ownerName(m.username)}
                      </option>
                    ))}
                  </select>
                  {active.assignee ? (
                    <span className="mon-drawer-owner-state">
                      由 <b>{ownerName(active.assignee)}</b> 跟进
                    </span>
                  ) : members.length === 0 ? (
                    <span className="mon-drawer-owner-hint">
                      暂无团队成员：对话页右键消息「标记为团队客服」后即可指派
                    </span>
                  ) : (
                    <span className="mon-drawer-owner-hint">指派后列表可按人筛选跟进</span>
                  )}
                </div>

                {detailLoading ? (
                  <div className="mon-drawer-empty">加载证据中…</div>
                ) : !detail ? (
                  <div className="mon-drawer-empty">无证据详情</div>
                ) : (
                  <div className="mon-drawer-tl">
                    {detail.related.map((m, i) => (
                      <div
                        key={i}
                        className={`mon-tl-item${m.isSend || m.senderIsTeam ? ' is-my' : ''}`}
                      >
                        <span className="mon-tl-dot" />
                        <div className="mon-tl-body">
                          <div className="mon-tl-head">
                            <b>
                              {m.isSend
                                ? `我方 · ${m.senderName}`
                                : m.senderIsTeam
                                  ? `团队 · ${m.senderName}`
                                  : m.senderName}
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
                  <IssueActions
                    issue={detail ?? active}
                    onSet={(s) => void applyStatus(active.id, s)}
                  />
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
