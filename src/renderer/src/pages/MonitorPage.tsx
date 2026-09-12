import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkbenchStore } from '../stores/workbench'
import { toast } from '../stores/toast'
import { confirmAsk } from '../stores/confirmDialog'
import EChart from '../components/EChart'
import {
  computeMonitorData,
  fmtTimeShort,
  ageText,
  type MonitorData
} from '../../../shared/monitorMetrics'
import { useTeamNames } from '../lib/teamNames'
import { PlanBanner, type DuplicatePlanView } from '../components/monitor/PlanBanner'
import { KpiCard } from '../components/monitor/IssueBits'
import { statusChip } from '../lib/monitorChips'
import { IssueDrawer } from '../components/monitor/IssueDrawer'
import {
  buildAgeOption,
  buildGroupOption,
  buildTrendOption,
  buildTypeOption
} from './monitorCharts'
import type {
  FeedbackIssue,
  FeedbackIssueDetail,
  FeedbackIssueSeverity,
  FeedbackIssueStatus,
  FeedbackIssueType,
  FeedbackAnalysisState,
  LarkBaseStatus
} from '../../../shared/types'
import './monitor.css'

/**
 * 问题监控中心(管理者视角 BI + Bug 追踪):
 * KPI 大卡 → 钻取追踪列表(状态处置/指派跟进人/时间线/定位聊天) → 趋势/类型/群榜/积压年龄图表。
 * 数据源:本地 issue 库(cs:issue:list/detail/setStatus),无新增后端聚合。
 */

type StatusFilter = 'open' | 'doubt' | 'done' | 'stalled' | 'archived' | 'all'
const TYPE_OPTIONS: FeedbackIssueType[] = ['客诉', '售后', '物流', '价格', '咨询', '建议', '其他']

const RANGE_OPTIONS = [7, 14, 30]
/** 单次回传的明细行上限（KPI 已由主进程按全量算，明细超限即截断并提示） */
const ROW_LIMIT = 1000
/** 问题列表每页条数选项（默认 15） */
const PAGE_SIZES = [15, 30, 50, 100]

function MonitorPage(): React.JSX.Element {
  const wxid = useWorkbenchStore((s) => s.wxid)
  const source = useWorkbenchStore((s) => s.source)
  const locateIssueAt = useWorkbenchStore((s) => s.locateIssueAt)
  const connected = !!wxid && source === 'wx' && wxid !== 'wxid_demo'
  const issueApi = window.api?.cs?.issue
  /**
   * 前端桥自检：preload 属于「重启才生效」的部分，热更新只换来 UI 而桥还是旧的 ——
   * 这时按钮看着在、点了却什么都不发生。显式探测并提示重启，比静默失败强。
   */
  const hasMaintenanceApi = typeof issueApi?.mergeDuplicates === 'function'

  const [issues, setIssues] = useState<FeedbackIssue[]>([])
  /** 指标由主进程按**全量**数据算好回传（不再把全部问题过 IPC）；首次/异常时本地兜底 */
  const [serverMetrics, setServerMetrics] = useState<MonitorData | null>(null)
  /** 明细载荷信息：total=账号总条数，loaded=本次回传条数，truncated=是否被上限截断 */
  const [rowInfo, setRowInfo] = useState({ total: 0, loaded: 0, truncated: false })
  /** 渲染端比主进程新（未重启）：已退回全量通道，提示重启即可恢复聚合与限量 */
  const [skewed, setSkewed] = useState(false)
  const [loading, setLoading] = useState(false)
  /** 飞书多维表格同步状态(徽标 + 一键同步;与设置页同一份状态) */
  const [baseSync, setBaseSync] = useState<LarkBaseStatus | null>(null)
  const [baseBusy, setBaseBusy] = useState('')
  /** 未配置时的一键配置面板(不必再去设置页) */
  const [setupOpen, setSetupOpen] = useState(false)
  const [setupLink, setSetupLink] = useState('')
  const [setupBusy, setSetupBusy] = useState(false)
  const [setupNotes, setSetupNotes] = useState<string[]>([])
  /** preload 桥是否含同步接口(旧构建/热更新后可能需要重启) */
  const hasBaseSyncApi = typeof window.api?.cs?.lark?.baseVerify === 'function'
  const [range, setRange] = useState(7)
  // 筛选与钻取
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open')
  const [typeFilter, setTypeFilter] = useState<'all' | FeedbackIssueType>('all')
  const [groupFilter, setGroupFilter] = useState('')
  const [keyword, setKeyword] = useState('')
  // 分页表格：默认每页 15 条
  const [pageSize, setPageSize] = useState(15)
  const [page, setPage] = useState(1)
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
  // 全量重析进度(逐群推进;可中途取消)
  const [progress, setProgress] = useState<{
    done: number
    total: number
    current?: string
  } | null>(null)
  const [dupPlan, setDupPlan] = useState<DuplicatePlanView | null>(null)
  const [archiveAsk, setArchiveAsk] = useState(false)
  // 跟进人：团队成员 + 展示名解析（与聊天右侧面板共用同一个 hook，口径一致）
  const [teamReloadKey, setTeamReloadKey] = useState(0)
  const { members, nameOf: ownerName } = useTeamNames(connected ? wxid : null, teamReloadKey)
  const teamUsernames = useMemo(() => members.map((m) => m.username), [members])
  const [ownerFilter, setOwnerFilter] = useState('')
  const [sevFilter, setSevFilter] = useState<'all' | FeedbackIssueSeverity>('all')

  /**
   * 取监控数据。
   * 优先用 `cs:issue:overview`（主进程按全量聚合、明细限量）；
   * 若主进程还是旧版（渲染端热更新后没重启，主进程没有该 handler），
   * 自动退回旧的 `cs:issue:list` 全量通道并提示重启 —— 版本错位不该表现为「报错 + 空列表」。
   */
  const load = useCallback(async (): Promise<void> => {
    if (!connected || !issueApi) return
    setLoading(true)
    try {
      if (typeof issueApi.overview === 'function') {
        const res = await issueApi
          .overview(wxid!, {
            rangeDays: range,
            backlogHours: thresh.backlog,
            limit: ROW_LIMIT
          })
          .catch(() => null)
        if (res && res.ok) {
          const rows = res.issues ?? []
          setIssues(rows)
          setServerMetrics(res.metrics ?? null)
          setRowInfo({
            total: res.total ?? rows.length,
            loaded: res.loaded ?? rows.length,
            truncated: !!res.truncated
          })
          setSkewed(false)
        } else {
          if (res && res.error) toast.error(res.error)
          await loadLegacy()
        }
      } else {
        await loadLegacy()
      }
      const st = await issueApi.state(wxid!)
      if (st.ok && st.state) setAnaState(st.state)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '读取问题失败')
    } finally {
      setLoading(false)
    }
    /** 旧主进程兜底：全量列表 + 本地算指标（与 overview 同一份纯函数，口径一致） */
    async function loadLegacy(): Promise<void> {
      const legacy = await issueApi?.list(wxid!).catch(() => null)
      if (legacy && legacy.ok && legacy.issues) {
        const rows = legacy.issues
        setIssues(rows)
        setServerMetrics(null)
        setRowInfo({ total: rows.length, loaded: rows.length, truncated: false })
        setSkewed(true)
      } else {
        toast.error((legacy as { error?: string } | null)?.error || '读取问题失败')
      }
    }
  }, [connected, wxid, issueApi, range, thresh.backlog])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 进入页面异步加载(回调内 setState,全仓同款模式)
    void load()
  }, [load])

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

  // 全量重析进度推送(逐群推进;done/cancelled 收尾即收起)
  useEffect(() => {
    const unsub = issueApi?.onProgress?.((p) => {
      if (p?.phase === 'done' || p?.phase === 'cancelled') {
        setProgress(null)
        return
      }
      setProgress({ done: p?.done ?? 0, total: p?.total ?? 0, current: p?.current })
    })
    return () => unsub?.()
  }, [issueApi])

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

  // 正式口径(排除疑似)与疑似桶:指标/图表/默认待办均只统计正式问题
  const formalIssues = useMemo(() => issues.filter((i) => !i.needConfirm), [issues])
  const doubtIssues = useMemo(() => issues.filter((i) => i.needConfirm), [issues])
  const doubtOpen = doubtIssues.filter((i) => i.status === 'open').length

  // 服务端口径优先（基于全量数据），未就绪时用同一份纯函数本地兜底，保证首屏不空
  const metrics = useMemo(
    () =>
      serverMetrics ?? computeMonitorData(formalIssues, range, { backlogHours: thresh.backlog }),
    [serverMetrics, formalIssues, range, thresh.backlog]
  )
  // 严重度计数(正式 open):紧急/高危 卡片与筛选项
  const sevCount = useMemo(() => {
    const open = formalIssues.filter((i) => i.status === 'open')
    return {
      urgent: open.filter((i) => i.severity === '紧急').length,
      high: open.filter((i) => i.severity === '高').length
    }
  }, [formalIssues])

  const filtered = useMemo(() => {
    let list = statusFilter === 'doubt' ? doubtIssues : formalIssues
    if (statusFilter === 'open') list = list.filter((i) => i.status === 'open')
    else if (statusFilter !== 'all' && statusFilter !== 'doubt')
      list = list.filter((i) => i.status === statusFilter)
    if (typeFilter !== 'all') list = list.filter((i) => i.type === typeFilter)
    if (sevFilter !== 'all') list = list.filter((i) => (i.severity ?? '一般') === sevFilter)
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
  }, [
    formalIssues,
    doubtIssues,
    statusFilter,
    typeFilter,
    sevFilter,
    groupFilter,
    ownerFilter,
    keyword
  ])

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

  // 疑似确认:核实为真问题 → 清除疑似标记(正式进入待办口径)
  const applyConfirmDoubt = useCallback(
    async (id: number): Promise<void> => {
      const patch = (it: FeedbackIssue): FeedbackIssue => ({ ...it, needConfirm: false })
      setIssues((prev) => prev.map((it) => (it.id === id ? patch(it) : it)))
      setActive((prev) => (prev && prev.id === id ? patch(prev) : prev))
      setDetail((prev) => (prev && prev.id === id ? { ...prev, needConfirm: false } : prev))
      const res = await issueApi?.confirmDoubt(id).catch(() => null)
      if (!res?.ok) {
        toast.error((res as { error?: string } | null)?.error || '确认失败')
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

  // 默认选中第一条(正式待办列表第一行;用户已选择或改动过筛选时不打扰)
  useEffect(() => {
    if (active || loading || statusFilter !== 'open') return
    if (
      keyword.trim() ||
      typeFilter !== 'all' ||
      groupFilter ||
      ownerFilter ||
      sevFilter !== 'all'
    ) {
      return
    }
    const first = formalIssues.find((i) => i.status === 'open')
    if (!first) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 进入页面默认选中第一条并展开详情(全仓同款模式)
    void openDetail(first)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    issues,
    formalIssues,
    loading,
    active,
    statusFilter,
    typeFilter,
    groupFilter,
    ownerFilter,
    sevFilter,
    keyword
  ])

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
          severity: i.severity ?? '一般',
          needConfirm: i.needConfirm ?? false,
          reopenCount: i.reopenCount ?? 0,
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

  /** 取消正在跑的全量重析(按群边界停下,已扫过的群结果保留) */
  const cancelAnalyze = async (): Promise<void> => {
    if (!connected || !issueApi) return
    await issueApi.cancel(wxid!).catch(() => null)
    toast.success('已请求取消:当前群跑完即停止')
  }

  /** 全量重析(近 7 天全部活跃群;原看板维护操作迁移至此) */
  const runFullAnalyze = async (): Promise<void> => {
    if (!connected || !issueApi || anaBusy) return
    setAnaBusy(true)
    setProgress(null)
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

  /**
   * 存量去重:合并历史上因锚点漂移产生的重复议题。
   * 先 dryRun 拿方案做预览(列出每组保留谁、合并几条),确认后才真正执行。
   */
  const runMergeDuplicates = async (): Promise<void> => {
    if (anaBusy) return
    if (!issueApi?.mergeDuplicates) {
      toast.error('当前运行版本未加载该功能：请完全退出应用后重新启动（preload 变更需重启）')
      return
    }
    if (!connected || !wxid) {
      toast.error('尚未连接微信账号：请先到「设置 → 微信数据与密钥」连接')
      return
    }
    const pre = await issueApi.mergeDuplicates(wxid, true).catch((e: unknown) => {
      toast.error(`重复检测失败：${e instanceof Error ? e.message : String(e)}`)
      return null
    })
    if (!pre) return
    if (!pre.ok) {
      toast.error(pre.error || '重复检测失败')
      return
    }
    if (!pre.merged || !pre.plan?.length) {
      setDupPlan(null)
      toast.success('没有发现重复议题')
      return
    }
    setArchiveAsk(false)
    setDupPlan({ clusters: pre.clusters ?? 0, merged: pre.merged, plan: pre.plan })
  }

  /** 用户点「执行合并」：真正落库（方案已在页内展示过） */
  const executeMergeDuplicates = async (): Promise<void> => {
    if (!issueApi?.mergeDuplicates || !wxid) return
    setAnaBusy(true)
    try {
      const res = await issueApi.mergeDuplicates(wxid, false).catch((e: unknown) => {
        toast.error(`合并失败：${e instanceof Error ? e.message : String(e)}`)
        return null
      })
      if (!res) return
      if (!res.ok) {
        toast.error(res.error || '合并失败')
        return
      }
      setDupPlan(null)
      toast.success(`已合并 ${res.clusters ?? 0} 组，归档 ${res.merged ?? 0} 条重复记录`)
      setActive(null)
      setDetail(null)
      await load()
    } finally {
      setAnaBusy(false)
    }
  }

  /** 归档 90 天前已闭环记录(长期运营收敛:活跃列表/盯办只留近期,闭环率与趋势不受影响) */
  const runArchiveStale = async (): Promise<void> => {
    if (!issueApi?.archiveStale) {
      toast.error('当前运行版本未加载该功能：请完全退出应用后重新启动（preload 变更需重启）')
      return
    }
    if (!connected || !wxid) {
      toast.error('尚未连接微信账号：请先到「设置 → 微信数据与密钥」连接')
      return
    }
    setDupPlan(null)
    setArchiveAsk(true)
  }

  /** 用户点「确认归档」：真正执行 */
  const executeArchiveStale = async (): Promise<void> => {
    if (!issueApi?.archiveStale || !wxid) return
    const res = await issueApi.archiveStale(wxid, 90).catch((e: unknown) => {
      toast.error(`归档失败：${e instanceof Error ? e.message : String(e)}`)
      return null
    })
    if (!res) return
    if (!res.ok) {
      toast.error(res.error || '归档失败')
      return
    }
    setArchiveAsk(false)
    toast.success(res.archived ? `已归档 ${res.archived} 条历史记录` : '没有需要归档的历史记录')
    await load()
  }

  /** 清空账号全部问题记录(含证据与历史,不可恢复) */
  const runClearAll = async (): Promise<void> => {
    if (!connected || !issueApi) return
    const ok = await confirmAsk({
      title: '清空全部问题记录',
      message:
        '将删除该账号的全部问题记录(含证据与历史,不可恢复)。清空后可点「全量重析」从近 7 天群消息重新提取。',
      confirmText: '清空全部',
      danger: true
    })
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
  const trendOption = useMemo(() => buildTrendOption(metrics), [metrics])
  const typeOption = useMemo(() => buildTypeOption(metrics), [metrics])
  const groupOption = useMemo(() => buildGroupOption(metrics), [metrics])
  const ageOption = useMemo(() => buildAgeOption(metrics), [metrics])

  const pageTotal = Math.max(1, Math.ceil(filtered.length / pageSize))
  const curPage = Math.min(page, pageTotal)
  const pageItems = filtered.slice((curPage - 1) * pageSize, curPage * pageSize)

  /** 读取飞书同步状态(失败静默:未配置时不该在监控页报错;同步完成后也会刷新) */
  const loadBaseSync = useCallback((): void => {
    void window.api?.cs?.lark
      ?.baseStatus()
      .then((r) => {
        if (r?.ok && r.status) setBaseSync(r.status)
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    let alive = true
    void window.api?.cs?.lark
      ?.baseStatus()
      .then((r) => {
        if (alive && r?.ok && r.status) setBaseSync(r.status)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  /**
   * 一键配置:粘贴链接 → 执行并建表(带 table= 就写进你指定的表) → 认领既有行 → 首批全量同步。
   * 目标:从「未配置」到「数据进表」只需一次点击,不必先去设置页。
   */
  const runQuickSetup = async (): Promise<void> => {
    const api = window.api?.cs?.lark
    if (!api?.baseVerify) {
      toast.error('当前运行的构建不含同步接口:请完全退出并重启应用后再试')
      return
    }
    if (!wxid) {
      toast.error('还没连接微信账号:同步需要账号作用域')
      return
    }
    const link = setupLink.trim()
    if (!link) {
      toast.error('请粘贴多维表格链接（…/base/xxxx?table=tblxxxx）')
      return
    }
    setSetupBusy(true)
    setSetupNotes([])
    try {
      const res = await api.baseVerify(link)
      if (res.status) setBaseSync(res.status)
      const notes = [...(res.notes ?? [])]
      if (!res.ok) {
        setSetupNotes([...notes, res.error ?? '配置失败'])
        toast.error(res.error || '配置失败')
        return
      }
      // 已有历史行先认领,避免重复插入
      if (api.baseClaim) {
        const c = await api.baseClaim(wxid).catch(() => null)
        if (c?.ok && c.claimed) {
          notes.push(
            `认领既有行:扫描 ${c.claimed.scanned} · 认领 ${c.claimed.claimed} · 无法匹配 ${c.claimed.unmatched}`
          )
        }
      }
      setSetupNotes(notes)
      toast.success('多维表格已就绪,开始首批同步…')
      const sync = await api.baseSync(wxid, true)
      if (sync.status) setBaseSync(sync.status)
      if (sync.ok) {
        const out = sync.result
        // 面板承诺"开启每 2 分钟自动同步":这里真的打开(否则用户会误以为在自动同步)
        const cfg = await api.baseConfig({ enabled: true }).catch(() => null)
        if (cfg?.status) setBaseSync(cfg.status)
        toast.success(
          `首批同步完成:新增 ${out?.created ?? 0} · 更新 ${out?.updated ?? 0};已开启每 2 分钟自动同步`
        )
        setSetupOpen(false)
      } else {
        const err = sync.error || sync.result?.error || '首批同步失败'
        setSetupNotes([...notes, err])
        toast.error(err)
      }
    } finally {
      setSetupBusy(false)
    }
  }

  /** 监控页「同步到飞书」:先拉同事改动再推本地变更(与设置页同一实现) */
  const syncBaseNow = async (): Promise<void> => {
    const api = window.api?.cs?.lark
    if (!api?.baseSync) return
    if (!wxid) {
      toast.error('还没连接微信账号:同步需要账号作用域')
      return
    }
    if (!baseSync?.configured) {
      toast.error('还没配置多维表格链接:请到 设置 → AI 助手 → 议题同步到多维表格 配置')
      return
    }
    setBaseBusy('sync')
    try {
      const res = await api.baseSync(wxid, false)
      if (res.status) setBaseSync(res.status)
      else loadBaseSync()
      if (res.ok) {
        const out = res.result
        const pulled = res.pulled
        const ev = res.evidence
        toast.success(
          `已同步飞书表格:新增 ${out?.created ?? 0} · 更新 ${out?.updated ?? 0}${
            pulled && pulled.applied > 0 ? ` · 采纳同事改动 ${pulled.applied}` : ''
          }${
            ev && !ev.error
              ? ` · 证据新增 ${ev.created}${ev.failed ? `(失败 ${ev.failed})` : ''}`
              : ''
          }`
        )
      } else {
        toast.error(res.error || res.result?.error || '同步失败(详见 设置 → 议题同步 的最近记录)')
      }
    } finally {
      setBaseBusy('')
    }
  }

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
          {/* 飞书多维表格同步:未配置时点一下就地配置;已配置则一键同步(详细记录在 设置 → 议题同步) */}
          <button
            type="button"
            className="mon-btn ghost"
            disabled={baseBusy !== '' || setupBusy}
            onClick={() => {
              if (baseSync?.configured) void syncBaseNow()
              else setSetupOpen((v) => !v)
            }}
            title={
              baseSync?.configured
                ? `同步到飞书表格(已映射 ${baseSync.mappedIssues} 条${
                    baseSync.evidence?.enabled
                      ? ` · 证据 ${baseSync.mappedEvidence ?? 0} 条${baseSync.pendingEvidence ? `(待推 ${baseSync.pendingEvidence})` : ''}`
                      : ' · 证据明细未开启'
                  })${baseSync.pullNote ? `\n最近一轮拉取:${baseSync.pullNote}` : ''}${
                    baseSync.lastResult?.error ? `\n上次失败:${baseSync.lastResult.error}` : ''
                  }`
                : '尚未配置:请到 设置 → AI 助手 → 议题同步到多维表格 粘贴链接并执行'
            }
          >
            {baseBusy === 'sync' || setupBusy
              ? '同步中…'
              : baseSync?.configured
                ? `同步到飞书${baseSync.enabled ? '' : '（自动同步已关）'}`
                : setupOpen
                  ? '收起配置'
                  : '同步到飞书（点此配置）'}
          </button>
          {baseSync?.configured && (
            <span
              className={`mon-ana-state${baseSync.lastResult && !baseSync.lastResult.ok ? ' is-bad' : ''}`}
              title="飞书多维表格同步状态"
            >
              {baseSync.lastAt > 0
                ? `飞书同步 ${fmtTimeShort(baseSync.lastAt)} · 映射 ${baseSync.mappedIssues} 条${
                    baseSync.lastResult?.failed ? ` · 失败 ${baseSync.lastResult.failed}` : ''
                  }`
                : `飞书同步待运行 · 映射 ${baseSync.mappedIssues} 条`}
              {baseSync.evidence?.enabled
                ? ` · 证据 ${baseSync.mappedEvidence ?? 0} 条${
                    baseSync.pendingEvidence ? `(待推 ${baseSync.pendingEvidence})` : ''
                  }`
                : ''}
              {baseSync.evidence?.media
                ? ` · 附件 ${baseSync.attachedEvidence ?? 0} 条(素材 ${baseSync.mappedMedia ?? 0} 张)`
                : ''}
            </span>
          )}
          {anaState?.lastAt && !anaBusy && (
            <span
              className="mon-ana-state"
              title={
                anaState.error ||
                `上次全量重析覆盖 ${anaState.groups ?? '?'}/${anaState.groupsTotal ?? '?'} 个活跃群`
              }
            >
              上次分析 {fmtTimeShort(anaState.lastAt)}
              {anaState.method === 'llm' ? ' · AI 提取' : ' · 规则提取'}
              {anaState.cancelled ? ' · 已取消' : ''}
              {typeof anaState.groups === 'number' && anaState.groupsTotal
                ? ` · ${anaState.groups}/${anaState.groupsTotal} 群`
                : ''}
              {anaState.groupsCapped ? ' · 群数超限' : ''}
              {anaState.error ? ' · 上次失败' : ''}
            </span>
          )}
          <button
            type="button"
            className="mon-btn ghost"
            disabled={anaBusy || loading}
            onClick={() => void runFullAnalyze()}
            title="对全部活跃群按近 7 天重新分析提取(数据量大时较慢,可中途取消)"
          >
            {anaBusy
              ? progress
                ? `分析中 ${progress.done}/${progress.total}`
                : '分析中…'
              : '全量重析'}
          </button>
          {anaBusy && (
            <button
              type="button"
              className="mon-btn ghost"
              onClick={() => void cancelAnalyze()}
              title="停止剩余群的分析;已扫过的群结果保留"
            >
              取消
            </button>
          )}
          <button
            type="button"
            className="mon-btn ghost"
            disabled={anaBusy}
            onClick={() => void runMergeDuplicates()}
            title="按标题/证据/客户判据找出历史上被重复提取的同一议题,先预览再合并"
          >
            合并重复
          </button>
          <button
            type="button"
            className="mon-btn ghost"
            disabled={anaBusy}
            onClick={() => void runArchiveStale()}
            title="把 90 天前已解决/已搁置的记录归档:不再占用活跃列表与盯办,闭环率与趋势照旧统计"
          >
            归档历史
          </button>
          <button
            type="button"
            className="mon-btn danger"
            onClick={() => void runClearAll()}
            title="删除该账号全部问题记录(不可恢复)"
          >
            清空数据
          </button>
          {!hasMaintenanceApi && (
            <span
              className="mon-ana-state"
              title="preload 桥属于重启才生效的部分:热更新只换了界面,功能代码还是旧的"
            >
              ⚠ 维护功能未加载:请完全退出并重启应用
            </span>
          )}
          {skewed && hasMaintenanceApi && (
            <span
              className="mon-ana-state"
              title="主进程还是旧版(没有 cs:issue:overview):已自动退回全量列表 + 本地算指标。重启应用即可恢复主进程聚合与明细限量。"
            >
              ⚠ 主进程版本较旧:已用兼容模式加载,建议重启应用
            </span>
          )}
        </div>
      </div>

      {/* 未配置:就地粘贴链接 → 执行并建表 → 认领既有行 → 首批同步 */}
      {setupOpen && !baseSync?.configured && (
        <div className="mon-sync-setup">
          <div className="mon-sync-note">
            把多维表格的分享链接粘进来就行。<b>链接里带了表格参数，就会写进你指定的那张表</b>
            （只补列、不新建表）；不带则自动新建「议题」与「数字员工回复」两张表。
            执行成功后会立刻全量同步一次，并开启每 2 分钟自动同步。
          </div>
          <div className="mon-sync-row">
            <input
              className="mon-input"
              value={setupLink}
              onChange={(e) => setSetupLink(e.target.value)}
              placeholder="粘贴多维表格分享链接（…/base/xxxxx）"
            />
            <button
              type="button"
              className="mon-btn"
              disabled={setupBusy}
              onClick={() => void runQuickSetup()}
            >
              {setupBusy ? '配置并同步中…' : '执行并建表 + 首批同步'}
            </button>
            <button
              type="button"
              className="mon-btn ghost"
              disabled={setupBusy}
              onClick={() => setSetupOpen(false)}
            >
              取消
            </button>
          </div>
          {setupNotes.length > 0 && (
            <div className="mon-sync-note" style={{ marginTop: 6 }}>
              {setupNotes.map((n, i) => (
                <div key={i}>· {n}</div>
              ))}
            </div>
          )}
          {!hasBaseSyncApi && (
            <div className="mon-ana-state is-bad" style={{ marginTop: 6 }}>
              ⚠ 当前运行的构建不含同步接口:请完全退出并重启应用后再试
            </div>
          )}
        </div>
      )}

      <PlanBanner
        dupPlan={dupPlan}
        archiveAsk={archiveAsk}
        busy={anaBusy}
        onExecuteMerge={() => void executeMergeDuplicates()}
        onCancelMerge={() => setDupPlan(null)}
        onExecuteArchive={() => void executeArchiveStale()}
        onCancelArchive={() => setArchiveAsk(false)}
      />

      {!connected ? (
        <div className="mon-empty">
          尚未连接微信:请先到 设置 → 微信数据与密钥 连接账号;本地已有人工处理的问题也会展示。
        </div>
      ) : (
        <>
          {/* KPI 大卡 */}
          <div className="mon-kpis">
            <KpiCard
              label="紧急待办"
              value={sevCount.urgent}
              hint={`另有 ${sevCount.high} 条高危`}
              tone="danger"
            />
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
              hint={
                metrics.kpis.archivedClosed > 0
                  ? `已闭环 ÷ 全部已处理过；含历史归档 ${metrics.kpis.archivedClosed} 条`
                  : '已闭环 ÷ 全部已处理过'
              }
              tone="ok"
            />
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
                    setPage(1)
                  }}
                >
                  <option value="open">只看待处理/跟进中</option>
                  <option value="doubt">疑似待确认{doubtOpen > 0 ? `(${doubtOpen})` : ''}</option>
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
                    setPage(1)
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
                  value={sevFilter}
                  onChange={(e) => {
                    setSevFilter(e.target.value as 'all' | FeedbackIssueSeverity)
                    setPage(1)
                  }}
                  title="按严重度筛选"
                >
                  <option value="all">全部严重度</option>
                  <option value="紧急">
                    紧急{sevCount.urgent > 0 ? `(${sevCount.urgent})` : ''}
                  </option>
                  <option value="高">高{sevCount.high > 0 ? `(${sevCount.high})` : ''}</option>
                  <option value="一般">一般</option>
                </select>
                <select
                  className="mon-select"
                  value={groupFilter}
                  onChange={(e) => {
                    setGroupFilter(e.target.value)
                    setPage(1)
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
                    setPage(1)
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
                    setPage(1)
                  }}
                />
                {rowInfo.truncated && (
                  <span
                    className="mon-ana-state"
                    title="KPI/趋势按全量数据统计；明细为控制传输量只回传最近的若干条，更早的可用状态/类型筛选或「归档历史」收敛"
                  >
                    明细已加载 {rowInfo.loaded}/{rowInfo.total} 条
                  </span>
                )}
              </div>

              {pageItems.length === 0 ? (
                <div className="mon-empty">没有符合条件的问题{loading ? '（加载中…）' : ''}</div>
              ) : (
                <>
                  <div className="mon-tbl-head">
                    <span className="mon-th-st">状态</span>
                    <span className="mon-th-type">类型</span>
                    <span className="mon-th-main">问题</span>
                    <span className="mon-th-owner">跟进人</span>
                    <span className="mon-th-age">积压</span>
                  </div>
                  <div className="mon-tbl-body">
                    {pageItems.map((it) => {
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
                            <span className="mon-row-flags">
                              {it.severity && it.severity !== '一般' && (
                                <em
                                  className={`mon-sev is-${it.severity === '紧急' ? 'urgent' : 'high'}`}
                                >
                                  {it.severity}
                                </em>
                              )}
                              {(it.reopenCount ?? 0) > 0 && (
                                <em className="mon-reopen">复发 ×{it.reopenCount}</em>
                              )}
                            </span>
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
                              title={
                                it.assignee ? `跟进人：${ownerName(it.assignee)}` : '指派跟进人'
                              }
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
                  </div>
                  <div className="mon-pager">
                    <span className="mon-pager-info">
                      共 {filtered.length} 条 · 第 {curPage} / {pageTotal} 页
                      {groupFilter ? '（已按群钻取）' : ''}
                    </span>
                    <div className="mon-pager-ctrl">
                      <select
                        className="mon-select"
                        value={pageSize}
                        aria-label="每页条数"
                        title="每页条数"
                        onChange={(e) => {
                          setPageSize(Number(e.target.value))
                          setPage(1)
                        }}
                      >
                        {PAGE_SIZES.map((n) => (
                          <option key={n} value={n}>
                            {n} 条/页
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="mon-btn ghost"
                        disabled={curPage <= 1}
                        onClick={() => setPage(curPage - 1)}
                      >
                        ‹ 上一页
                      </button>
                      <button
                        type="button"
                        className="mon-btn ghost"
                        disabled={curPage >= pageTotal}
                        onClick={() => setPage(curPage + 1)}
                      >
                        下一页 ›
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>

            <IssueDrawer
              active={active}
              detail={detail}
              detailLoading={detailLoading}
              members={members}
              ownerName={ownerName}
              wxid={wxid ?? ''}
              teamUsernames={teamUsernames}
              onMarkTeam={() => setTeamReloadKey((k) => k + 1)}
              onClose={() => {
                setActive(null)
                setDetail(null)
              }}
              onAssign={(id, username) => void applyAssignee(id, username)}
              onSetStatus={(id, s) => void applyStatus(id, s)}
              onConfirmDoubt={(id) => void applyConfirmDoubt(id)}
              onLocate={(sessionUsername, at) => void locateIssueAt(sessionUsername, at)}
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
        </>
      )}
    </div>
  )
}

export default MonitorPage
