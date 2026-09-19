/**
 * 营销 AI 工作台: 左任务列表 / 中对话 / 右产出面板。
 * 复用客服工作台的事件通道(ai:wb)与审批桥; 一个素材 = 一个任务, 多任务并行。
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from '../stores/toast'
import SkeletonRows from '../components/growth/SkeletonRows'
import { useEscape } from '../lib/useEscape'
import { fmtStamp } from '../../../shared/monitorMetrics'
import { ToolTimeline } from '../components/workbench/ToolTimeline'
import { Lightbox, type LightboxItem } from '../components/growth/MediaGallery'
import { splitToolRuns, type TimelineItem } from '../lib/toolTimeline'
import { growthApi } from '../components/growth/meta'
import PublishRecordForm from '../components/growth/PublishRecordForm'
import { useWorkbenchStore } from '../stores/workbench'
import type { GrowthMetricView, GrowthRemixOutputView } from '../../../shared/growth'
import './growth-ai.css'
import { useAsyncEffect } from '../lib/useAsyncEffect'

interface TaskView {
  id: number
  contentId: number
  contentTitle: string
  contentKind: string
  contentOrigin: string
  storeId: number | null
  storeName: string
  title: string
  /** 该任务此刻是否在生成中（主进程按运行中的会话标记） */
  running?: boolean
  goal: string
  status: string
  sessionId: number | null
  summary: string
  updatedAt: number
  lastMessageAt: number | null
  pendingCandidates: number
  /** 素材封面(本地相对路径) */
  contentCover: string
  /** 任务产出图(本地相对路径, 最多 4 张) */
  outputImages: string[]
}

interface OutputAssetView {
  id: number
  assetId: number | null
  role: string
  source: string
  prompt: string
  note: string
  relPath: string
}

interface OutputView {
  id: number
  taskId: number | null
  variant: string
  title: string
  copy: string
  complianceHints: string[]
  status: string
  createdAt: number
  assets: OutputAssetView[]
  /** 生图产出带 meta.strategy：按哪个模板/平台/比例生成的（让「策略」在界面上看得见） */
  meta?: Record<string, unknown>
}

interface StoreView {
  id: number
  brandName: string
  name: string
  city: string
  enabled: boolean
}

/** 素材仓库可选素材(新建任务用) */
interface MaterialOption {
  id: number
  title: string
  origin: string
  kind: string
  authorName: string
  score: number
  interactions: { likes: number }
}

interface ChatRow {
  id: number
  role: string
  kind: string
  content: string
  meta?: Record<string, unknown> | null
  createdAt: number
}

interface ToolRow {
  name: string
  status: 'start' | 'done' | 'fail'
  args?: string
  output?: string
  /** 收到 start/done 事件的时间（时间线据此判定顺序 vs 并行） */
  startedAt?: number
  endedAt?: number
}

interface ApprovalRow {
  runId: string
  tool: string
  text: string
}

/** 工具步骤消息(engine 落库的 kind=tool_call 行) → 时间线条目 */
function toolItemsOfMessages(rows: ChatRow[]): TimelineItem[] {
  return rows.map((m) => {
    const meta = parseToolMeta(m)
    return {
      id: m.id,
      name: meta?.name ?? '工具',
      status: meta?.status ?? 'done',
      args: meta?.args,
      output: meta?.output
    }
  })
}

/** 实时 toolLog 行 → 时间线条目（带事件到达时间，能判并行） */
function toolItemOf(t: ToolRow, i: number): TimelineItem {
  return {
    id: 'live-' + String(i) + '-' + t.name,
    name: t.name,
    status: t.status,
    startedAt: t.startedAt,
    endedAt: t.endedAt,
    args: t.args,
    output: t.output
  }
}

/** meta 可能是 JSON 字符串(仓储层原样返回)也可能是对象，两种都认 */
function parseToolMeta(
  m: ChatRow
): { name: string; status: TimelineItem['status']; args?: string; output?: string } | null {
  const raw = m.meta
  let obj: Record<string, unknown> | null = null
  if (typeof raw === 'string' && raw) {
    try {
      const p = JSON.parse(raw) as unknown
      obj = p && typeof p === 'object' ? (p as Record<string, unknown>) : null
    } catch {
      obj = null
    }
  } else if (raw && typeof raw === 'object') {
    obj = raw as Record<string, unknown>
  }
  if (!obj) return null
  const status = obj.status === 'fail' ? 'fail' : 'done'
  return {
    name: typeof obj.name === 'string' && obj.name ? obj.name : '工具',
    status,
    args: typeof obj.args === 'string' && obj.args ? obj.args : undefined,
    output: typeof obj.output === 'string' ? obj.output : undefined
  }
}

/** 单条消息(memo: 流式刷新时不重渲染历史消息) */
const ChatMessage = memo(function ChatMessage({ m }: { m: ChatRow }): React.JSX.Element | null {
  if (m.kind === 'error') {
    return <div className="gai-msg is-error">{m.content}</div>
  }
  if (m.kind !== 'text') return null
  return (
    <div className={'gai-msg ' + (m.role === 'user' ? 'is-user' : 'is-ai')}>
      <div className="gai-msg-text">{m.content}</div>
    </div>
  )
})

const growthaiApi = window.api?.cs?.growthai
const wbApi = window.api?.cs?.wb

const GOAL_OPTIONS: Array<{ id: string; label: string }> = [
  { id: 'image_text', label: '图文(小红书/抖音)' },
  { id: 'video', label: '短视频脚本' },
  { id: 'moments', label: '朋友圈' },
  { id: 'group', label: '客户群群发' }
]

const ORIGIN_LABEL: Record<string, string> = {
  xhs: '小红书',
  douyin: '抖音',
  self: '自有',
  manual: '手工'
}

const KIND_LABEL: Record<string, string> = {
  image_text: '图文',
  video: '视频',
  unknown: '未知'
}

const fmtNum = (n: number): string => (n >= 10000 ? (n / 10000).toFixed(1) + 'w' : String(n))

const VARIANT_LABEL: Record<string, string> = {
  'chat:title': '标题候选',
  'chat:copy1': '正文候选 A',
  'chat:copy2': '正文候选 B',
  'chat:copy3': '正文候选 C',
  'chat:image': '生成图候选',
  'chat:cover': '封面候选'
}

/**
 * 生图策略回显。此前策略只活在模型的脑子里（prompt 由模型临场写），
 * 用户看不出这张图是按什么模板/平台/比例生成的，也就无从纠正。
 */
const StrategyNote = memo(function StrategyNote({
  o
}: {
  o: OutputView
}): React.JSX.Element | null {
  const st = (o.meta?.strategy ?? null) as { notes?: unknown } | null
  const notes = Array.isArray(st?.notes)
    ? (st?.notes as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    : []
  if (notes.length === 0) return null
  return <div className="gai-out-strategy">{notes.join(' · ')}</div>
})

/** 时间一律精确到时分秒(共享实现) */
const fmtTime = (ts: number | null): string => fmtStamp(ts)

interface TaskCardProps {
  t: TaskView
  active: boolean
  /** 入场动画序号 */
  index?: number
  onSelect: (id: number) => void
  onDelete: (t: TaskView) => void
}

/** 任务卡片: 素材封面 + 标题/阶段/摘要 + 产出缩略图行(memo:流式每帧重渲染页面时列表不动) */
const TaskCard = memo(function TaskCard({
  t,
  active,
  index,
  onSelect,
  onDelete
}: TaskCardProps): React.JSX.Element {
  const cover = t.contentCover
  const outs = (t.outputImages ?? []).filter(Boolean).slice(0, 4)
  return (
    <div
      role="button"
      tabIndex={0}
      className={'gai-task' + (active ? ' is-active' : '')}
      style={{ '--i': index ?? 0 } as React.CSSProperties}
      onClick={() => onSelect(t.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSelect(t.id)
      }}
      title={t.contentTitle || t.title}
    >
      <span className="gai-task-cover">
        {cover ? (
          <img
            src={'ct-growth://media/' + cover}
            alt=""
            loading="lazy"
            decoding="async"
            onError={(e) => {
              e.currentTarget.style.display = 'none'
            }}
          />
        ) : (
          <span className="gai-task-cover-empty">{(t.title || '素')[0]}</span>
        )}
      </span>
      <span className="gai-task-body">
        <span className="gai-task-title">
          {t.title || t.contentTitle || '未命名任务'}
          {t.pendingCandidates > 0 ? <i className="gai-dot" title="有待确认候选" /> : null}
        </span>
        <span className="gai-task-sub">
          {t.running ? (
            <span className="gai-task-running" title="该任务正在生成（可切过去看进度）">
              <i className="gai-run-dot" />
              执行中
            </span>
          ) : null}
          {/* 任务进度以摘要为准：原「阶段」列没有任何写入点，显示的永远是「拆解」 */}{' '}
          {t.summary || '待开始'}
        </span>
        <span className="gai-task-meta">
          {fmtTime(t.lastMessageAt ?? t.updatedAt)}
          {t.storeName ? ' · ' + t.storeName : ''}
        </span>
        {outs.length > 0 ? (
          <span className="gai-task-thumbs">
            {outs.map((p, i) => (
              <img
                key={String(i)}
                src={'ct-growth://media/' + p}
                alt=""
                loading="lazy"
                decoding="async"
              />
            ))}
          </span>
        ) : null}
        <span className="gai-task-tools">
          <button
            type="button"
            className="gai-task-del"
            title="删除任务"
            onClick={(e) => {
              e.stopPropagation()
              onDelete(t)
            }}
          >
            删除
          </button>
        </span>
      </span>
    </div>
  )
})

/** 流式气泡:父组件每帧 setState,这里单独 memo 让重渲染范围最小 */
const StreamBubble = memo(function StreamBubble({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="gai-msg is-ai">
      <div className="gai-msg-text">{text}</div>
    </div>
  )
})

interface Props {
  focusTaskId: number | null
  onFocusConsumed: () => void
  onChanged: () => void
}

export default function GrowthAiWorkbench({
  focusTaskId,
  onFocusConsumed,
  onChanged
}: Props): React.JSX.Element {
  const [tasks, setTasks] = useState<TaskView[]>([])
  const [tasksLoading, setTasksLoading] = useState(true)
  const [stores, setStores] = useState<StoreView[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [task, setTask] = useState<TaskView | null>(null)
  const [outputs, setOutputs] = useState<OutputView[]>([])
  const [candidates, setCandidates] = useState<OutputView[]>([])
  /** 缩略图加载失败的行（本地文件可能已被清理）——不显示破图，改成一个明确的占位 */
  const [imgFailed, setImgFailed] = useState<Record<number, true>>({})
  /** 大图预览：候选/产出里的图点开看，同一块内可 ←/→ 翻；候选块还能直接在预览里采用 */
  const [zoom, setZoom] = useState<{
    items: LightboxItem[]
    assetIds: Array<number | null>
    index: number
    outputId: number
    adoptable: boolean
  } | null>(null)
  const [messages, setMessages] = useState<ChatRow[]>([])
  /** 连续的工具步骤合成一条时间线（与客服工作台同一手法：纯函数切段） */
  const chatRuns = useMemo(
    () =>
      splitToolRuns(
        messages.map((m) => ({
          id: m.id,
          isTool: m.role !== 'user' && m.kind === 'tool_call',
          msg: m
        }))
      ),
    [messages]
  )
  const [streaming, setStreaming] = useState('')
  const [toolLog, setToolLog] = useState<ToolRow[]>([])
  const [approval, setApproval] = useState<ApprovalRow | null>(null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const chatRef = useRef<HTMLDivElement | null>(null)
  const sessionRef = useRef<number | null>(null)
  /** 流式 token 缓冲: 按帧合并 setState, 避免每个 token 都重渲染整个工作台 */
  const streamBufRef = useRef('')
  const streamRafRef = useRef<number | null>(null)
  /** 聊天区是否吸底(用户向上翻阅时不打断) */
  const stickRef = useRef(true)

  // 新建任务(从素材仓库选素材)
  const [pickOpen, setPickOpen] = useState(false)
  const [pickKeyword, setPickKeyword] = useState('')
  const [pickItems, setPickItems] = useState<MaterialOption[]>([])
  const [pickLoading, setPickLoading] = useState(false)
  const [pickStoreId, setPickStoreId] = useState(0)
  const [pickGoal, setPickGoal] = useState('image_text')
  const [creating, setCreating] = useState(0)

  // 出口：把「采用」的结果送出工作台（导出发布包 / 登记发布 / 回仓库）
  const [pubOpen, setPubOpen] = useState(false)
  const [pubMetrics, setPubMetrics] = useState<GrowthMetricView[]>([])
  const [pubOutputs, setPubOutputs] = useState<GrowthRemixOutputView[]>([])
  const [exporting, setExporting] = useState(false)

  const loadTasks = useCallback(async (): Promise<void> => {
    if (!growthaiApi) return
    const res = await growthaiApi.listTasks()
    if (res.ok) setTasks((res.tasks ?? []) as TaskView[])
    setTasksLoading(false)
  }, [])

  const loadStores = useCallback(async (): Promise<void> => {
    if (!growthaiApi) return
    const res = await growthaiApi.listStores()
    if (res.ok) setStores((res.stores ?? []) as StoreView[])
  }, [])

  const loadMaterials = useCallback(async (kw: string): Promise<void> => {
    const api = window.api?.cs?.growth
    if (!api) return
    setPickLoading(true)
    const res = await api.listContent({ keyword: kw.trim(), sort: 'score', limit: 50, offset: 0 })
    setPickLoading(false)
    if (res.ok) setPickItems((res.items ?? []) as MaterialOption[])
    else toast.error(res.error || '读取素材失败')
  }, [])

  const closePick = useCallback((): void => setPickOpen(false), [])

  useEscape(pickOpen, closePick)

  /**
   * 打开「登记发布」。
   *
   * 为什么要现拉一次 getContent 而不是用手上的 outputs：这个表单要展示「效果登记历史」，
   * 那是素材级的数据(growth_metric_snapshot)，本页只加载了任务级产出，攒不出来。
   */
  const openPublish = useCallback(async (contentId: number): Promise<void> => {
    if (!growthApi?.getContent) {
      toast.error('通道未就绪（改到主进程/preload 后需完全重启应用）')
      return
    }
    const res = await growthApi.getContent(contentId)
    if (!res.ok) {
      toast.error(res.error || '读取素材详情失败')
      return
    }
    if (!res.item) {
      toast.error('素材不存在（可能已被删除）')
      return
    }
    setPubMetrics(res.item.metrics ?? [])
    setPubOutputs(res.item.remixOutputs ?? [])
    setPubOpen(true)
  }, [])

  const closePublish = useCallback((): void => setPubOpen(false), [])

  useEscape(pubOpen, closePublish)

  /**
   * 导出发布包：只带**本任务已采用**的产出 id，避免把同一素材下别的任务的产出一起塞进包。
   * 目录由主进程弹窗选择，导出后直接打开，省得用户再去翻「数据」页。
   */
  const exportPkg = useCallback(async (): Promise<void> => {
    if (!task) return
    if (!growthApi?.exportPackage) {
      toast.error('通道未就绪（改到主进程/preload 后需完全重启应用）')
      return
    }
    setExporting(true)
    try {
      const res = await growthApi.exportPackage(
        task.contentId,
        outputs.map((o) => o.id)
      )
      if (!res.ok) {
        // 用户自己点的「取消」不是失败，别弹红条
        if (res.error !== '已取消导出') toast.error(res.error || '导出失败')
        return
      }
      toast.success('发布包已导出(' + String(res.files ?? 0) + ' 个文件)')
      const openFolder = window.api?.cs?.export?.openFolder
      if (res.dir && openFolder) void openFolder(res.dir)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '导出失败')
    } finally {
      setExporting(false)
    }
  }, [task, outputs])

  const goWarehouse = useCallback((): void => {
    useWorkbenchStore.getState().setGrowthTab('warehouse')
  }, [])

  const openPick = useCallback((): void => {
    setPickOpen(true)
    void loadMaterials('')
  }, [loadMaterials])

  const createFromMaterial = useCallback(
    async (m: MaterialOption): Promise<void> => {
      if (!growthaiApi) return
      setCreating(m.id)
      const res = await growthaiApi.createTask({
        contentId: m.id,
        storeId: pickStoreId || null,
        goal: pickGoal
      })
      setCreating(0)
      if (!res.ok || !res.taskId) {
        toast.error(res.error || '创建任务失败')
        return
      }
      toast.success('已创建爆改任务')
      setPickOpen(false)
      await loadTasks()
      setActiveId(res.taskId)
      onChanged()
    },
    [pickStoreId, pickGoal, loadTasks, onChanged]
  )

  /** 把缓冲的流式文本按帧刷进 state */
  const flushStream = useCallback((): void => {
    streamRafRef.current = null
    setStreaming(streamBufRef.current)
  }, [])

  const resetStream = useCallback((): void => {
    if (streamRafRef.current !== null) {
      cancelAnimationFrame(streamRafRef.current)
      streamRafRef.current = null
    }
    streamBufRef.current = ''
    setStreaming('')
  }, [])

  const loadBundle = useCallback(async (taskId: number): Promise<void> => {
    if (!growthaiApi) return
    const res = await growthaiApi.getTask(taskId)
    if (!res.ok) {
      toast.error(res.error || '任务读取失败')
      return
    }
    const t = res.task as TaskView
    setTask(t)
    sessionRef.current = t.sessionId
    setOutputs((res.outputs ?? []) as OutputView[])
    setCandidates((res.candidates ?? []) as OutputView[])
    const mres = await growthaiApi.messages(taskId)
    if (mres.ok) setMessages((mres.messages ?? []) as ChatRow[])
  }, [])

  // 初始加载
  useAsyncEffect(() => {
    void loadTasks()
    void loadStores()
  }, [loadTasks, loadStores])

  // 有任务在生成时轮询任务列表：营销页是多任务并行，左栏的运行态得跟得上（没有任务在跑时不起定时器）
  const anyRunning = sending || tasks.some((t) => t.running)
  useEffect(() => {
    if (!anyRunning) return
    const timer = setInterval(() => void loadTasks(), 4000)
    return () => clearInterval(timer)
  }, [anyRunning, loadTasks])

  // 素材仓库跳转进来: 选中该任务
  useEffect(() => {
    if (focusTaskId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 外部跳转要求选中任务
      setActiveId(focusTaskId)
      onFocusConsumed()
    }
  }, [focusTaskId, onFocusConsumed])

  // 选中任务后加载详情
  useEffect(() => {
    if (!activeId) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 切换任务时重载详情
    void loadBundle(activeId)
    resetStream()
    setToolLog([])
    setApproval(null)
  }, [activeId, loadBundle, resetStream])

  // 订阅引擎事件(按会话过滤)
  useEffect(() => {
    if (!wbApi?.onEvent) return
    const unsub = wbApi.onEvent((evt: unknown) => {
      const e = evt as {
        sessionId?: number
        type?: string
        token?: string
        tool?: string
        toolStatus?: string
        args?: string
        output?: string
        runId?: string
        approvalText?: string
        text?: string
      }
      if (!e.sessionId || e.sessionId !== sessionRef.current) return
      if (e.type === 'delta' && e.token) {
        streamBufRef.current += e.token
        if (streamRafRef.current === null) {
          streamRafRef.current = requestAnimationFrame(flushStream)
        }
      } else if (e.type === 'tool') {
        const name = e.tool ?? ''
        const status = (e.toolStatus ?? 'start') as ToolRow['status']
        setToolLog((prev) => {
          const next = [...prev]
          if (status === 'start') {
            next.push({ name, status: 'start', args: e.args, startedAt: Date.now() })
          } else {
            for (let i = next.length - 1; i >= 0; i -= 1) {
              if (next[i].name === name && next[i].status === 'start') {
                next[i] = { ...next[i], status, output: e.output, endedAt: Date.now() }
                return next
              }
            }
            next.push({ name, status, output: e.output, endedAt: Date.now() })
          }
          return next
        })
      } else if (e.type === 'approval') {
        setApproval({ runId: e.runId ?? '', tool: e.tool ?? '', text: e.approvalText ?? '' })
      } else if (e.type === 'done') {
        resetStream()
        setSending(false)
        // 先重载（工具步骤已按 tool_call 落库，重载后就由消息流渲染），再清实时列表 ——
        // 反过来会有一瞬间两边都没有，看起来像「工具调用突然消失」
        if (activeId) {
          void loadBundle(activeId).then(() => setToolLog([]))
        } else {
          setToolLog([])
        }
        void loadTasks()
      } else if (e.type === 'error') {
        resetStream()
        setSending(false)
        if (e.text) toast.error(e.text)
      } else if (e.type === 'status' && e.text === '生成中') {
        setSending(true)
      }
    })
    return unsub
  }, [activeId, loadBundle, loadTasks, flushStream, resetStream])

  // 卸载时取消挂起的流式刷新
  useEffect(
    () => () => {
      if (streamRafRef.current !== null) cancelAnimationFrame(streamRafRef.current)
    },
    []
  )

  // 自动滚到底(用户上翻阅读时不打断)
  useEffect(() => {
    const el = chatRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [messages, streaming, toolLog])

  /** 距底部 80px 内视为「跟随最新」 */
  const onChatScroll = useCallback((): void => {
    const el = chatRef.current
    if (!el) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }, [])

  const send = async (): Promise<void> => {
    if (!growthaiApi || !activeId) return
    const text = input.trim()
    if (!text) return
    setInput('')
    setSending(true)
    setToolLog([])
    setMessages((prev) => [
      ...prev,
      { id: -Date.now(), role: 'user', kind: 'text', content: text, createdAt: Date.now() }
    ])
    const res = await growthaiApi.sendMessage(activeId, text)
    if (!res.ok) {
      setSending(false)
      toast.error(res.error || '发送失败')
    }
  }

  const stop = (): void => {
    if (growthaiApi && activeId) void growthaiApi.stop(activeId)
    setSending(false)
  }

  const resolveApproval = async (ok: boolean): Promise<void> => {
    if (!approval || !wbApi?.approve) return
    await wbApi.approve(approval.runId, ok)
    setApproval(null)
  }

  /** 图的角标：导出包按顺序命名「封面 / 图2 / 图3」，界面用同一套口径，避免两边对不上 */
  const imgBadge = (i: number): string => (i === 0 ? '封面' : '图' + String(i + 1))

  /** 打开大图预览（items 与缩略图同序，翻页时下标一一对应） */
  const openZoom = (o: OutputView, index: number, adoptable: boolean): void => {
    setZoom({
      items: o.assets.map((a, i) => ({
        relPath: a.relPath,
        badge: imgBadge(i),
        note: [a.role === 'cover' ? '封面位' : '正文图', a.note || a.prompt || a.source]
          .filter(Boolean)
          .join(' · ')
      })),
      assetIds: o.assets.map((a) => a.assetId),
      index,
      outputId: o.id,
      adoptable
    })
  }

  const resolveCandidate = async (
    outputId: number,
    action: 'select' | 'archive' | 'delete' | 'pick',
    assetId?: number
  ): Promise<void> => {
    if (!growthaiApi || !activeId) return
    const res = await growthaiApi.resolveCandidate(activeId, outputId, action, assetId)
    if (!res.ok) {
      toast.error(res.error || '操作失败')
      return
    }
    if (action === 'select') toast.success('已采用, 见右侧产出')
    // pick: 一次生图 N 张落在同一产出块里, 只采用点的那一张(其余由主进程删掉)
    if (action === 'pick') toast.success('已采用这张图, 见右侧产出')
    await loadBundle(activeId)
    void loadTasks()
  }

  const revert = async (outputId: number): Promise<void> => {
    if (!growthaiApi || !activeId) return
    await growthaiApi.revertOutput(outputId)
    await loadBundle(activeId)
  }

  const removeTask = useCallback(
    async (t: TaskView): Promise<void> => {
      if (!growthaiApi) return
      // 确认框由主进程弹出(系统原生对话框, 避免渲染层弹窗被遮挡)
      const res = await growthaiApi.deleteTask(t.id)
      if (!res.ok) {
        if (res.error !== '已取消删除') toast.error(res.error || '删除失败')
        return
      }
      // 乐观移除, 避免依赖刷新
      setTasks((prev) => prev.filter((x) => x.id !== t.id))
      if (activeId === t.id) {
        setActiveId(null)
        setTask(null)
        setMessages([])
        setOutputs([])
        setCandidates([])
      }
      toast.success('任务已删除')
      void loadTasks()
      onChanged()
    },
    [activeId, loadTasks, onChanged]
  )
  /** memo 列表的稳定回调:内联箭头每次渲染都是新引用,会击穿 TaskCard 的 memo */
  const removeTaskStable = useCallback((t: TaskView): void => void removeTask(t), [removeTask])

  const patchTask = async (patch: Record<string, unknown>): Promise<void> => {
    if (!growthaiApi || !activeId) return
    await growthaiApi.updateTask(activeId, patch)
    await loadBundle(activeId)
    void loadTasks()
  }

  const copyText = async (text: string): Promise<void> => {
    const api = window.api?.cs?.growth
    if (!api) return
    const res = await api.copyClipboard({ text })
    if (res.ok) toast.success('已复制, 到微信粘贴即可')
  }

  const runningTasks = tasks.filter((t) => t.status === 'drafting')
  const doneTasks = tasks.filter((t) => t.status !== 'drafting')

  if (!growthaiApi) {
    return <div className="gth-error">营销 AI 工作台不可用(请重启应用以加载最新主进程)</div>
  }

  return (
    <div className="gai-page">
      <aside className="gai-tasks">
        <div className="gai-tasks-head">
          <span>爆改任务</span>
          <button className="ui-btn is-primary gth-btn sm" type="button" onClick={openPick}>
            + 新建
          </button>
          <button className="ui-btn gth-btn sm" type="button" onClick={() => void loadTasks()}>
            刷新
          </button>
        </div>
        <div className="gai-tasks-hint">从素材仓库选一条爆款创建任务, 再与 AI 对话逐项爆改</div>
        {runningTasks.length > 0 ? <div className="gai-group">进行中</div> : null}
        {runningTasks.map((t, i) => (
          <TaskCard
            key={t.id}
            t={t}
            index={i}
            active={activeId === t.id}
            onSelect={setActiveId}
            onDelete={removeTaskStable}
          />
        ))}
        {doneTasks.length > 0 ? <div className="gai-group">已完成</div> : null}
        {doneTasks.map((t, i) => (
          <TaskCard
            key={t.id}
            t={t}
            index={i + runningTasks.length}
            active={activeId === t.id}
            onSelect={setActiveId}
            onDelete={removeTaskStable}
          />
        ))}
        {tasks.length === 0 ? (
          tasksLoading ? (
            <div className="gai-tasks-skel">
              <SkeletonRows rows={4} cols={1} />
            </div>
          ) : (
            <div className="gai-empty">还没有任务</div>
          )
        ) : null}
      </aside>

      <section className="gai-main">
        {task ? (
          <>
            <header className="gai-head">
              {task.contentCover ? (
                <img
                  className="gai-head-cover"
                  src={'ct-growth://media/' + task.contentCover}
                  decoding={'async'}
                  alt=""
                />
              ) : null}
              <div className="gai-head-title" title={task.contentTitle}>
                {task.contentTitle || task.title}
              </div>
              <select
                className="ui-select gth-select"
                style={{ width: 150 }}
                value={task.goal}
                onChange={(e) => void patchTask({ goal: e.target.value })}
              >
                {GOAL_OPTIONS.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.label}
                  </option>
                ))}
              </select>
              <select
                className="ui-select gth-select"
                style={{ width: 160 }}
                value={task.storeId === null ? '' : String(task.storeId)}
                onChange={(e) =>
                  void patchTask({ storeId: e.target.value ? Number(e.target.value) : null })
                }
              >
                <option value="">选择门店…</option>
                {stores.map((s) => (
                  <option key={s.id} value={String(s.id)}>
                    {(s.brandName ? s.brandName + ' · ' : '') + s.name}
                  </option>
                ))}
              </select>
              {task.status === 'drafting' ? (
                <button
                  className="ui-btn gth-btn sm"
                  type="button"
                  onClick={() => void patchTask({ status: 'done' })}
                  title="标记任务完成"
                >
                  完成
                </button>
              ) : (
                <button
                  className="ui-btn gth-btn sm"
                  type="button"
                  onClick={() => void patchTask({ status: 'drafting' })}
                >
                  重新打开
                </button>
              )}
              <button
                className="ui-btn is-danger gth-btn sm"
                type="button"
                onClick={() => void removeTask(task)}
              >
                删除
              </button>
            </header>

            <div className="gai-chat" ref={chatRef} onScroll={onChatScroll}>
              {chatRuns.map((run) =>
                run.tool ? (
                  <ToolTimeline
                    key={'tl-' + String(run.rows[0].id)}
                    items={toolItemsOfMessages(run.rows.map((r) => r.msg))}
                  />
                ) : (
                  <ChatMessage key={run.row.msg.id} m={run.row.msg} />
                )
              )}
              {toolLog.length > 0 && <ToolTimeline items={toolLog.map(toolItemOf)} />}
              {streaming ? <StreamBubble text={streaming} /> : null}
              {approval ? (
                <div className="gai-approval">
                  <span>需要确认: {approval.tool}</span>
                  <span className="gai-approval-text">{approval.text}</span>
                  <button
                    className="ui-btn is-primary gth-btn sm"
                    type="button"
                    onClick={() => void resolveApproval(true)}
                  >
                    允许
                  </button>
                  <button
                    className="ui-btn gth-btn sm"
                    type="button"
                    onClick={() => void resolveApproval(false)}
                  >
                    拒绝
                  </button>
                  <span className="gai-approval-hint" title="引擎侧等待上限 120 秒">
                    120 秒内答复，超时按「拒绝」处理
                  </span>
                </div>
              ) : null}
              {sending && !streaming && toolLog.length === 0 ? (
                <div className="gai-msg is-ai gai-thinking">思考中…</div>
              ) : null}
            </div>

            <div className="gai-composer">
              <textarea
                className="ui-textarea gai-input"
                rows={3}
                value={input}
                placeholder="直接说改什么, 例如: 换 5 个标题突出人均; 正文改成探店风 120 字; 生成一张暖色火锅氛围封面…"
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send()
                }}
              />
              <div className="gai-composer-btns">
                {sending ? (
                  <button className="ui-btn gth-btn" type="button" onClick={stop}>
                    停止
                  </button>
                ) : (
                  <button
                    className="ui-btn is-primary gth-btn"
                    type="button"
                    disabled={!input.trim()}
                    onClick={() => void send()}
                  >
                    发送 (Ctrl+Enter)
                  </button>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="gai-empty-main">
            从左侧选择任务, 或点左上角「+ 新建」从素材仓库选一条爆款创建任务。
          </div>
        )}
      </section>

      <aside className="gai-output">
        {/* 产出面板就是这条素材的终点站：采用之后必须能直接送出工作台。
            此前导出发布包与登记发布只在「素材仓库」的详情里有入口，用户得自己记住
            「先去仓库找这条素材」——闭环在最后一跳断掉。 */}
        <div className="gai-out-head is-acts">
          <span>产出</span>
          {task ? (
            <span className="gai-out-acts">
              <button
                className="ui-btn gth-btn sm"
                type="button"
                disabled={exporting}
                title={
                  outputs.length > 0
                    ? '导出本任务已采用的产出 + 素材原文/原图到发布包文件夹'
                    : '本任务还没有采用的产出，将导出该素材最新的爆改产出'
                }
                onClick={() => void exportPkg()}
              >
                {exporting ? '导出中…' : '导出发布包'}
              </button>
              <button
                className="ui-btn gth-btn sm"
                type="button"
                title="登记发布渠道与互动数据，回填后素材分与看板立即更新"
                onClick={() => void openPublish(task.contentId)}
              >
                登记发布
              </button>
              <button
                className="ui-btn gth-btn sm"
                type="button"
                title="回到素材仓库看这条素材的完整详情"
                onClick={goWarehouse}
              >
                素材仓库
              </button>
            </span>
          ) : null}
        </div>
        {outputs.length === 0 ? (
          <div className="gai-empty">还没有采用的产出</div>
        ) : (
          outputs.map((o) => (
            <div className="gai-out-card" key={o.id}>
              <div className="gai-out-variant">
                {VARIANT_LABEL[o.variant] ?? o.variant}
                <button
                  className="ui-btn gth-btn sm"
                  type="button"
                  onClick={() => void revert(o.id)}
                >
                  回退
                </button>
              </div>
              <StrategyNote o={o} />
              {o.title
                ? o.title
                    .split('\n')
                    .filter(Boolean)
                    .map((line, i) => (
                      <button
                        key={String(i)}
                        className="gth-title-line"
                        type="button"
                        title="点击复制"
                        onClick={() => void copyText(line)}
                      >
                        <span>{i + 1}.</span> {line}
                      </button>
                    ))
                : null}
              {o.copy ? (
                <>
                  <div className="gth-copy-text">{o.copy}</div>
                  <button
                    className="ui-btn gth-btn sm"
                    type="button"
                    onClick={() => void copyText(o.copy)}
                  >
                    复制正文
                  </button>
                </>
              ) : null}
              {o.assets.length > 0 ? (
                <div className="gai-thumbs">
                  {o.assets.map((a, i) => (
                    <div className="gai-thumb" key={a.id}>
                      <button
                        type="button"
                        className="gai-thumb-view"
                        title={a.note || a.prompt || '点击预览大图'}
                        onClick={() => openZoom(o, i, false)}
                      >
                        {imgFailed[a.id] || !a.relPath ? (
                          <span className="gai-thumb-missing">图片缺失</span>
                        ) : (
                          <img
                            className="gai-thumb-img"
                            src={'ct-growth://media/' + a.relPath}
                            alt={imgBadge(i)}
                            loading={'lazy'}
                            decoding={'async'}
                            onError={() => setImgFailed((m) => ({ ...m, [a.id]: true }))}
                          />
                        )}
                      </button>
                      <span className="gai-thumb-badge">{imgBadge(i)}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              {o.complianceHints.length > 0 ? (
                <div className="gai-hints">
                  {o.complianceHints.map((h) => (
                    <span className="gth-badge amber" key={h}>
                      {h}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ))
        )}

        <div className="gai-out-head">
          候选 {candidates.length > 0 ? '(' + String(candidates.length) + ')' : ''}
        </div>
        {candidates.length === 0 ? (
          <div className="gai-empty">暂无候选</div>
        ) : (
          candidates.map((c) => (
            <div className="gai-out-card is-candidate" key={c.id}>
              <div className="gai-out-variant">{VARIANT_LABEL[c.variant] ?? c.variant}</div>
              <StrategyNote o={c} />
              {c.title
                ? c.title
                    .split('\n')
                    .filter(Boolean)
                    .map((line, i) => (
                      <div className="gai-cand-line" key={String(i)}>
                        <span>{line}</span>
                        <button
                          className="ui-btn is-primary gth-btn sm"
                          type="button"
                          onClick={() => void resolveCandidate(c.id, 'select')}
                        >
                          采用
                        </button>
                      </div>
                    ))
                : null}
              {c.copy ? (
                <>
                  <div className="gth-copy-text">{c.copy}</div>
                  <div className="gai-cand-btns">
                    <button
                      className="ui-btn is-primary gth-btn sm"
                      type="button"
                      onClick={() => void resolveCandidate(c.id, 'select')}
                    >
                      采用
                    </button>
                    <button
                      className="ui-btn gth-btn sm"
                      type="button"
                      onClick={() => void copyText(c.copy)}
                    >
                      复制
                    </button>
                  </div>
                </>
              ) : null}
              {c.assets.length > 0 ? (
                <div className="gai-thumbs">
                  {c.assets.map((a, i) => (
                    <div className="gai-thumb" key={a.id}>
                      <button
                        type="button"
                        className="gai-thumb-view"
                        title={a.note || a.prompt || '点击预览大图'}
                        onClick={() => openZoom(c, i, true)}
                      >
                        {imgFailed[a.id] || !a.relPath ? (
                          <span className="gai-thumb-missing">图片缺失</span>
                        ) : (
                          <img
                            className="gai-thumb-img"
                            src={'ct-growth://media/' + a.relPath}
                            alt={imgBadge(i)}
                            loading={'lazy'}
                            decoding={'async'}
                            onError={() => setImgFailed((m) => ({ ...m, [a.id]: true }))}
                          />
                        )}
                      </button>
                      <span className="gai-thumb-badge">{imgBadge(i)}</span>
                      {/* 采用按钮平时不占位：悬浮/键盘聚焦才出现（否则一屏十几个重复按钮很吵）。
                          点图本身是大图预览，采用也留在预览里，两条路都通。 */}
                      <button
                        type="button"
                        className="gai-thumb-adopt"
                        title="采用这一张"
                        onClick={() => void resolveCandidate(c.id, 'pick', a.assetId ?? undefined)}
                      >
                        用这张
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              <button
                className="ui-btn is-danger gth-btn sm"
                type="button"
                onClick={() => void resolveCandidate(c.id, 'delete')}
              >
                删除候选
              </button>
            </div>
          ))
        )}
      </aside>
      {zoom ? (
        <Lightbox
          items={zoom.items}
          index={zoom.index}
          onClose={() => setZoom(null)}
          onIndex={(i) => setZoom((z) => (z ? { ...z, index: i } : z))}
          actions={
            zoom.adoptable ? (
              <button
                className="ui-btn is-primary gth-btn sm"
                type="button"
                onClick={() => {
                  const assetId = zoom.assetIds[zoom.index] ?? undefined
                  void resolveCandidate(zoom.outputId, 'pick', assetId)
                  setZoom(null)
                }}
              >
                采用这张
              </button>
            ) : null
          }
        />
      ) : null}
      {pubOpen && task ? (
        <div className="gai-pick-mask" onClick={closePublish}>
          <div
            className="gai-pick gai-pub"
            role="dialog"
            aria-modal="true"
            aria-label="登记发布"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="gai-pick-head">
              <span className="t">
                登记发布 · {task.contentTitle || task.title || '未命名素材'}
              </span>
              <span className="s">
                渠道与互动数据回填后，素材分会重算，看板「营销内容效果」立即更新
              </span>
              <button className="ui-btn gth-btn sm" type="button" onClick={closePublish}>
                关闭
              </button>
            </div>
            <div className="gai-pub-body">
              <PublishRecordForm
                contentId={task.contentId}
                metrics={pubMetrics}
                outputs={pubOutputs}
                onSaved={async (): Promise<void> => {
                  // 重新拉一次，让「效果登记历史」把刚填的这条显示出来
                  const res = await growthApi?.getContent(task.contentId)
                  if (res?.ok && res.item) setPubMetrics(res.item.metrics ?? [])
                  onChanged()
                }}
              />
            </div>
          </div>
        </div>
      ) : null}
      {pickOpen ? (
        <div className="gai-pick-mask" onClick={() => setPickOpen(false)}>
          <div
            className="gai-pick"
            role="dialog"
            aria-modal="true"
            aria-label="新建爆改任务"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="gai-pick-head">
              <span className="t">新建爆改任务</span>
              <span className="s">选一条爆款素材, AI 先拆解结构, 再按你的要求爆改</span>
              <button
                className="ui-btn gth-btn sm"
                type="button"
                onClick={() => setPickOpen(false)}
              >
                关闭
              </button>
            </div>
            <div className="gai-pick-filters">
              <input
                autoFocus
                className="ui-input gth-input"
                placeholder="搜索素材标题 / 作者"
                value={pickKeyword}
                onChange={(e) => setPickKeyword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void loadMaterials(pickKeyword)
                }}
              />
              <button
                className="ui-btn gth-btn sm"
                type="button"
                onClick={() => void loadMaterials(pickKeyword)}
              >
                搜索
              </button>
              <select
                className="ui-select gth-select"
                value={pickStoreId}
                onChange={(e) => setPickStoreId(Number(e.target.value))}
              >
                <option value={0}>默认门店</option>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name || s.brandName || '门店 ' + String(s.id)}
                  </option>
                ))}
              </select>
              <select
                className="ui-select gth-select"
                value={pickGoal}
                onChange={(e) => setPickGoal(e.target.value)}
              >
                {GOAL_OPTIONS.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="gai-pick-list">
              {pickLoading ? (
                <div className="gai-empty">加载中…</div>
              ) : pickItems.length === 0 ? (
                <div className="gai-empty">没有匹配的素材, 先到「素材仓库」粘贴链接入库</div>
              ) : (
                pickItems.map((m) => (
                  <button
                    key={m.id}
                    className="gai-pick-row"
                    type="button"
                    disabled={creating === m.id}
                    onClick={() => void createFromMaterial(m)}
                  >
                    <span className="gai-pick-cover">{(m.title || '素')[0]}</span>
                    <span className="gai-pick-body">
                      <span className="gai-pick-title">{m.title || '(无标题)'}</span>
                      <span className="gai-pick-sub">
                        {ORIGIN_LABEL[m.origin] ?? m.origin} ·{KIND_LABEL[m.kind] ?? m.kind} ·
                        {m.authorName || '未知作者'} · 赞{fmtNum(m.interactions?.likes ?? 0)} · 分
                        {m.score > 0 ? m.score : '—'}
                      </span>
                    </span>
                    <span className="gai-pick-go">
                      {creating === m.id ? '创建中…' : '创建任务'}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
