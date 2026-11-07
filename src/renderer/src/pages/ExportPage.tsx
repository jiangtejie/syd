import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkbenchStore } from '../stores/workbench'
import { toast } from '../stores/toast'
import type { SessionSummary } from '../../../shared/types'
import { useAsyncEffect } from '../lib/useAsyncEffect'
import { virtualWindow } from '../lib/virtualList'
import './export.css'

/**
 * 数据导出页（参考 CipherTalk export 模块：会话多选 + 时间/格式 + 进度/结果）。
 * - 聊天记录：按会话导出 txt/html/json（流式读微信库，不含附件本体，记录 md5 引用）；
 * - 业务数据：本地派生数据 JSON 归档（群问题含证据/发送审计/团队/智能体/账号摘要，敏感项脱敏不导出）。
 */

type ExportTab = 'chat' | 'biz'
type SessionFilter = 'all' | 'group' | 'private' | 'oa'
type ChatFormat = 'txt' | 'html' | 'json'

interface ExportProgress {
  current: number
  total: number
  name: string
  detail: string
}

const wxApi = window.api?.cs?.wx
const exportApi = window.api?.cs?.export
const dialogApi = window.api?.cs?.dialog

/**
 * 会话列表行高（必须与 .exp-sess-row 的 height 一致）。
 * 窗口化按它算渲染切片 —— 两处对不上会出现行错位/滚动条长度不对。
 */
const ROW_H = 46
/** 视口上下各多渲染几行，滚动时不闪白 */
const OVERSCAN = 6

const RANGE_PRESETS = [
  { id: 'all', label: '全部时间' },
  { id: '7', label: '近 7 天' },
  { id: '30', label: '近 30 天' },
  { id: '90', label: '近 90 天' },
  { id: 'custom', label: '自定义' }
]

const RANGE_LABEL: Record<string, string> = Object.fromEntries(
  RANGE_PRESETS.map((r) => [r.id, r.label])
)

const FORMAT_LABEL: Record<ChatFormat, string> = {
  txt: '文本 TXT',
  html: '网页 HTML',
  json: '数据 JSON'
}

function ExportPage(): React.JSX.Element {
  const wxid = useWorkbenchStore((s) => s.wxid)
  const source = useWorkbenchStore((s) => s.source)
  const setPage = useWorkbenchStore((s) => s.setPage)
  const connected = !!wxid && source === 'wx' && wxid !== 'wxid_demo'

  const [tab, setTab] = useState<ExportTab>('chat')
  // 会话选择
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [filter, setFilter] = useState<SessionFilter>('all')
  const [keyword, setKeyword] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loadingSessions, setLoadingSessions] = useState(false)
  // 选项
  const [range, setRange] = useState('all')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [format, setFormat] = useState<ChatFormat>('txt')
  const [folder, setFolder] = useState('')
  // 运行态
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  /** 导出结果：成功文件 + 被跳过的会话（此前只显示文件数，另外那些会话去哪了没人说） */
  const [result, setResult] = useState<{
    files: Array<{ name: string; msgCount: number }>
    skipped: Array<{ name: string; reason: string }>
    /** 用户主动取消：与"失败"分开措辞（取消不是错） */
    cancelled?: boolean
  } | null>(null)
  /**
   * 两个页签的错误必须分开：以前共用一个 error，
   * 聊天记录导出失败后切到「业务数据」，会看到那条与业务数据无关的红字。
   */
  const [chatError, setChatError] = useState('')
  const [bizError, setBizError] = useState('')
  const [bizResult, setBizResult] = useState<string | null>(null)
  /** 仅看已选（会话多时用它确认自己到底选了哪些） */
  const [onlySelected, setOnlySelected] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  /** 会话列表窗口化：只渲染视口内的行（列表可能上千行，整表渲染每次勾选都重建全部 DOM） */
  const listRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(0)
  const busyRef = useRef(false)

  const loadSessions = useCallback(async (): Promise<void> => {
    if (!connected || !wxApi) return
    setLoadingSessions(true)
    try {
      const res = (await wxApi.getSessions(wxid!)) as {
        ok: boolean
        sessions?: SessionSummary[]
        error?: string
      }
      if (res.ok && res.sessions) {
        setSessions(res.sessions)
      } else {
        toast.error(res.error || '读取会话失败')
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '读取会话失败')
    } finally {
      setLoadingSessions(false)
    }
  }, [connected, wxid])

  // 进入页面异步加载会话列表（回调内 setState，全仓同款模式 → 走 useAsyncEffect）
  useAsyncEffect(loadSessions, [loadSessions])

  // 进度订阅
  useEffect(() => {
    const unsub = exportApi?.onProgress?.((evt) => {
      setProgress({ current: evt.current, total: evt.total, name: evt.name, detail: evt.detail })
    })
    return unsub
  }, [])

  const filtered = useMemo(() => {
    let list = sessions.filter(
      (s) => !/^(weixin|qqmail|fmessage|medianote|filehelper|newsapp)/i.test(s.username)
    )
    if (filter === 'group') list = list.filter((s) => s.isGroup)
    else if (filter === 'private') list = list.filter((s) => !s.isGroup && !s.isOfficialAccount)
    else if (filter === 'oa') list = list.filter((s) => s.isOfficialAccount)
    if (keyword.trim()) {
      const k = keyword.trim().toLowerCase()
      list = list.filter(
        (s) =>
          s.displayName?.toLowerCase().includes(k) ||
          s.nickname?.toLowerCase().includes(k) ||
          s.remark?.toLowerCase().includes(k) ||
          s.username.toLowerCase().includes(k)
      )
    }
    return list
  }, [sessions, filter, keyword])

  /** 列表实际渲染的集合：勾上「仅看已选」后只留已选中的（会话多时用它确认自己选了哪些） */
  const showOnlySelected = onlySelected && selected.size > 0
  const visible = useMemo(
    () => (showOnlySelected ? filtered.filter((s) => selected.has(s.username)) : filtered),
    [filtered, showOnlySelected, selected]
  )

  /** 窗口化切片（纯函数计算，见 lib/virtualList.ts；行高必须与 CSS 一致） */
  const win = virtualWindow({
    scrollTop,
    viewportH: viewH,
    rowH: ROW_H,
    total: visible.length,
    overscan: OVERSCAN
  })

  /** 时间范围提示：预设要说清**实际是哪几天**（"近 7 天"到底是哪 7 天，用户并不确定） */
  const rangeHint = useMemo(() => {
    const fmt = (d: Date): string =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    if (range === 'all') return '导出该会话的全部消息（不限时间）'
    if (range === 'custom') {
      const from = startDate || '最早'
      const to = endDate || '最新'
      return `实际范围：${from} ~ ${to}（留空的一端表示不限）`
    }
    const days = Number(range)
    const end = new Date()
    const start = new Date()
    start.setDate(start.getDate() - days + 1)
    return `实际范围：${fmt(start)} ~ ${fmt(end)}（含今天）`
  }, [range, startDate, endDate])

  /** 回调 ref：挂载/换页签重挂时量一次视口高度（在回调里 setState 是允许的，effect 体内不行） */
  const attachList = useCallback((el: HTMLDivElement | null): void => {
    listRef.current = el
    if (el) setViewH(el.clientHeight)
  }, [])

  // 窗口缩放导致列表变高变矮时跟住（只读事件里 setState）
  useEffect(() => {
    const el = listRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setViewH(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [tab, connected])

  /**
   * 过滤条件变化时把列表滚回顶部。
   * 放在事件处理器里而不是 effect 里：这是用户动作的直接结果，而且仓库有
   * react-hooks/set-state-in-effect 规则（effect 体内同步 setState 会被拦）。
   * 不重置的话，滚动位置可能落到新列表之外，看起来像"列表空了"。
   */
  const resetListScroll = useCallback((): void => {
    const el = listRef.current
    if (el) el.scrollTop = 0
    setScrollTop(0)
  }, [])

  const toggleOne = (username: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(username)) next.delete(username)
      else next.add(username)
      return next
    })
  }
  const toggleAll = (): void => {
    setSelected((prev) => {
      const allChecked = filtered.every((s) => prev.has(s.username))
      const next = new Set(prev)
      if (allChecked) filtered.forEach((s) => next.delete(s.username))
      else filtered.forEach((s) => next.add(s.username))
      return next
    })
  }

  // 记住上次导出目录：每次进页面都重选一次目录是纯浪费（配置走通用 cs:config）
  useAsyncEffect(async () => {
    const all = (await window.api?.cs?.config?.getAll().catch(() => null)) as Record<
      string,
      string
    > | null
    const saved = (all?.['export.folder'] ?? '').trim()
    if (saved) setFolder(saved)
  }, [])

  const applyFolder = (dir: string): void => {
    setFolder(dir)
    void window.api?.cs?.config?.set('export.folder', dir)
  }

  const pickFolder = async (): Promise<void> => {
    const r = await dialogApi?.pickDirectory('选择导出目录', folder || undefined)
    if (r?.ok && r.path) applyFolder(r.path)
  }

  const resolveRangeMs = (): { startMs?: number; endMs?: number } => {
    if (range === 'all') return {}
    if (range !== 'custom') {
      const days = Number(range)
      const end = new Date()
      end.setHours(23, 59, 59, 999)
      const start = new Date()
      start.setDate(start.getDate() - days + 1)
      start.setHours(0, 0, 0, 0)
      return { startMs: start.getTime(), endMs: end.getTime() }
    }
    const startMs = startDate ? new Date(`${startDate}T00:00:00`).getTime() : undefined
    const endMs = endDate ? new Date(`${endDate}T23:59:59.999`).getTime() : undefined
    if (startDate && endDate && startMs! > endMs!) {
      toast.error('开始日期不能晚于结束日期')
      return { startMs: undefined, endMs: undefined }
    }
    return { startMs, endMs }
  }

  const startChatExport = async (): Promise<void> => {
    if (!connected || !exportApi) {
      toast.error('未连接微信账号')
      return
    }
    if (selected.size === 0) {
      toast.error('请至少选择一个会话')
      return
    }
    // 目录规则与「业务数据」统一：没选就现在弹窗选，而不是把人堵在按钮上
    let dir = folder
    if (!dir) {
      const r = await dialogApi?.pickDirectory('选择导出目录')
      if (!r?.ok || !r.path) return
      dir = r.path
      applyFolder(dir)
    }
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setResult(null)
    setChatError('')
    try {
      const nameOf = new Map(sessions.map((s) => [s.username, s.displayName || s.username]))
      const targets = Array.from(selected).map((u) => ({
        username: u,
        displayName: nameOf.get(u) || u
      }))
      const rangeMs = resolveRangeMs()
      const res = await exportApi.chat(wxid!, {
        targets,
        format,
        folder: dir,
        startMs: rangeMs.startMs,
        endMs: rangeMs.endMs
      })
      const files = res.files ?? []
      const skipped = res.skipped ?? []
      // 部分成功 / 取消 都要如实展示：主进程会把已写成功的文件一起回传
      if (files.length > 0 || skipped.length > 0 || res.cancelled) {
        setResult({ files, skipped, cancelled: !!res.cancelled })
      }
      if (res.cancelled) {
        toast.success(`已取消导出（已完成 ${files.length} 个文件，保留在导出目录）`)
      } else if (res.ok) {
        toast.success(`已导出 ${files.length} 个会话`)
      } else {
        setChatError(res.error || '导出失败')
      }
    } catch (e) {
      setChatError(e instanceof Error ? e.message : '导出失败')
    } finally {
      busyRef.current = false
      setBusy(false)
      setProgress(null)
      setCancelling(false)
    }
  }

  const startBizExport = async (): Promise<void> => {
    if (!connected || !exportApi) {
      toast.error('未连接微信账号')
      return
    }
    let dir = folder
    if (!dir) {
      const r = await dialogApi?.pickDirectory('选择导出目录')
      if (!r?.ok || !r.path) return
      dir = r.path
      applyFolder(dir)
    }
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setBizResult(null)
    setBizError('')
    try {
      const res = await exportApi.business(wxid!, dir)
      if (res.cancelled) {
        toast.success('已取消导出（未生成文件）')
      } else if (res.ok && res.name) {
        setBizResult(res.name)
        toast.success('业务数据已导出')
      } else {
        setBizError(res.error || '导出失败')
      }
    } catch (e) {
      setBizError(e instanceof Error ? e.message : '导出失败')
    } finally {
      busyRef.current = false
      setBusy(false)
      setProgress(null)
      setCancelling(false)
    }
  }

  /** 请求取消：完成的部分照常保留（主进程会把已写成功的文件回传） */
  const cancelExport = async (): Promise<void> => {
    setCancelling(true)
    const res = await exportApi?.cancel().catch(() => null)
    if (res && !res.ok) {
      toast.error(res.error || '取消失败')
      setCancelling(false)
    }
  }

  const openFolder = async (): Promise<void> => {
    if (folder) await exportApi?.openFolder(folder)
  }

  /** 进度条（两个页签同一套；带 aria，读屏能知道进度） */
  const renderProgress = (): React.JSX.Element | null => {
    if (!progress) return null
    const pct = Math.round((progress.current / Math.max(1, progress.total)) * 100)
    return (
      <div
        className="exp-progress"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="exp-progress-head">
          <div className="exp-progress-text">
            正在导出 {progress.name}（{progress.current}/{progress.total}）· {progress.detail}
          </div>
          <button
            type="button"
            className="ui-btn is-sm is-ghost exp-btn"
            disabled={cancelling}
            onClick={() => void cancelExport()}
          >
            {cancelling ? '正在取消…' : '取消导出'}
          </button>
        </div>
        <div className="exp-bar">
          <div className="exp-bar-in" style={{ width: `${pct}%` }} />
        </div>
      </div>
    )
  }

  return (
    <div className="page-scroll exp-page">
      <h2 className="page-title">数据导出</h2>
      <div className="page-subtitle">
        导出微信会话与本地业务数据,用于留存/迁移/备份。敏感项(密钥/AI Key)一律不导出。
      </div>

      {!connected && (
        <div className="page-card exp-empty-state">
          <div className="ui-empty">
            <span className="ui-empty-glyph">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path
                  d="M10 3v9m0 0 3.2-3.2M10 12 6.8 8.8"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M3.5 13v2.5a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V13"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            <div className="ui-empty-title">尚未连接微信</div>
            <div className="ui-empty-desc">
              导出的是本机微信库里的真实消息，需要先导入密钥并连接账号。
            </div>
            <button type="button" className="ui-btn is-primary" onClick={() => setPage('settings')}>
              去设置微信数据与密钥
            </button>
          </div>
        </div>
      )}

      {connected && (
        <>
          <div className="exp-tabs" role="tablist" aria-label="导出类型">
            {(
              [
                ['chat', '聊天记录'],
                ['biz', '业务数据']
              ] as Array<[ExportTab, string]>
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={`ui-tab exp-tab${tab === id ? ' is-active' : ''}`}
                disabled={busy}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === 'chat' && (
            <div className="exp-chat-layout">
              {/* 左:会话选择 */}
              <div className="page-card exp-sessions">
                <div className="exp-toolbar">
                  <input
                    className="ui-input exp-input"
                    placeholder="搜索会话名称 / 微信号…"
                    value={keyword}
                    onChange={(e) => {
                      setKeyword(e.target.value)
                      resetListScroll()
                    }}
                  />
                  {keyword && (
                    <button
                      type="button"
                      className="ui-link"
                      onClick={() => {
                        setKeyword('')
                        resetListScroll()
                      }}
                    >
                      清除
                    </button>
                  )}
                  <select
                    className="ui-input ui-select exp-sel"
                    value={filter}
                    onChange={(e) => {
                      setFilter(e.target.value as SessionFilter)
                      resetListScroll()
                    }}
                  >
                    <option value="all">全部</option>
                    <option value="group">群聊</option>
                    <option value="private">私聊</option>
                    <option value="oa">公众号</option>
                  </select>
                </div>
                <div className="exp-sess-head">
                  <label className="exp-check">
                    <input
                      type="checkbox"
                      checked={
                        filtered.length > 0 && filtered.every((s) => selected.has(s.username))
                      }
                      disabled={busy}
                      onChange={toggleAll}
                    />
                    全选
                    <span className="exp-head-n ui-num">{filtered.length}</span>
                  </label>
                  <span className="exp-sess-count">
                    已选 <b className="ui-num">{selected.size}</b>
                  </span>
                  <label className="exp-check">
                    <input
                      type="checkbox"
                      checked={onlySelected}
                      disabled={selected.size === 0}
                      onChange={(e) => {
                        setOnlySelected(e.target.checked)
                        resetListScroll()
                      }}
                    />
                    仅看已选
                  </label>
                  <button
                    type="button"
                    className="ui-link"
                    disabled={busy || selected.size === 0}
                    onClick={() => setSelected(new Set())}
                  >
                    清空
                  </button>
                  <button
                    type="button"
                    className="ui-link"
                    disabled={busy}
                    onClick={() => {
                      resetListScroll()
                      void loadSessions()
                    }}
                  >
                    刷新
                  </button>
                </div>
                <div
                  className="exp-sess-list"
                  ref={attachList}
                  onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
                >
                  {loadingSessions && (
                    <div className="exp-loading">
                      <span className="ui-spin" />
                      正在读取会话列表…
                    </div>
                  )}
                  {!loadingSessions && visible.length === 0 && (
                    <div className="ui-empty exp-empty">
                      <span className="ui-empty-glyph">
                        <svg
                          width="20"
                          height="20"
                          viewBox="0 0 20 20"
                          fill="none"
                          aria-hidden="true"
                        >
                          <path
                            d="M3 4.5h14v10H8l-4 3v-3H3z"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </span>
                      <div className="ui-empty-title">
                        {showOnlySelected ? '还没有选中任何会话' : '没有可导出的会话'}
                      </div>
                      <div className="ui-empty-desc">
                        {showOnlySelected
                          ? '取消「仅看已选」，或先在左侧勾选要导出的会话。'
                          : '换个筛选条件，或点右上「刷新」重新读取微信会话列表。'}
                      </div>
                    </div>
                  )}
                  {/* 窗口化：只渲染视口内的行（会话可能上千行，整表渲染每次勾选都重建全部 DOM）。
                      外层撑满总高度保证滚动条长度正确，内层按 padTop 下移。 */}
                  {visible.length > 0 && (
                    <div style={{ height: visible.length * ROW_H, position: 'relative' }}>
                      <div style={{ transform: `translateY(${win.padTop}px)` }}>
                        {visible.slice(win.start, win.end).map((s) => {
                          const name = s.displayName || s.nickname || s.remark || s.username
                          return (
                            <label
                              key={s.username}
                              className={`exp-sess-row${selected.has(s.username) ? ' is-on' : ''}`}
                            >
                              <input
                                type="checkbox"
                                checked={selected.has(s.username)}
                                disabled={busy}
                                onChange={() => toggleOne(s.username)}
                              />
                              <span className="exp-sess-main">
                                <span className="exp-sess-name">
                                  {s.isGroup && <i className="ui-chip is-sm is-line exp-tag">群</i>}
                                  {s.isOfficialAccount && (
                                    <i className="ui-chip is-sm is-line exp-tag">公众号</i>
                                  )}
                                  <span className="exp-sess-name-text">{name}</span>
                                </span>
                                <span className="exp-sess-sub ui-num">{s.username}</span>
                              </span>
                            </label>
                          )
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* 右:选项与执行 */}
              <div className="page-card exp-opts">
                <section className="exp-section">
                  <div className="ui-label exp-section-title">时间范围</div>
                  <div className="ui-seg exp-seg" role="group" aria-label="时间范围">
                    {RANGE_PRESETS.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        className={`ui-seg-btn${range === r.id ? ' is-on' : ''}`}
                        disabled={busy}
                        onClick={() => setRange(r.id)}
                      >
                        {r.label}
                      </button>
                    ))}
                  </div>
                  {range === 'custom' && (
                    <div className="exp-date-row">
                      <input
                        type="date"
                        className="ui-input exp-input"
                        value={startDate}
                        aria-label="开始日期"
                        onChange={(e) => setStartDate(e.target.value)}
                      />
                      <span className="exp-date-sep">至</span>
                      <input
                        type="date"
                        className="ui-input exp-input"
                        value={endDate}
                        aria-label="结束日期"
                        onChange={(e) => setEndDate(e.target.value)}
                      />
                    </div>
                  )}
                  <div className="exp-hint">{rangeHint}</div>
                </section>

                <section className="exp-section">
                  <div className="ui-label exp-section-title">格式</div>
                  <div className="ui-seg exp-seg" role="group" aria-label="导出格式">
                    {(
                      [
                        ['txt', '文本 TXT'],
                        ['html', '网页 HTML'],
                        ['json', '数据 JSON']
                      ] as Array<[ChatFormat, string]>
                    ).map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        className={`ui-seg-btn${format === id ? ' is-on' : ''}`}
                        disabled={busy}
                        onClick={() => setFormat(id)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="exp-hint">
                    附件本体不包含在导出中（消息记录其 md5/文件名引用）；TXT 适合阅读，JSON
                    保留结构化字段便于未来导入。
                  </div>
                </section>

                <section className="exp-section">
                  <div className="ui-label exp-section-title">导出位置</div>
                  <div className="exp-folder-row">
                    <span className="exp-folder ui-num" title={folder || undefined}>
                      {folder || '未选择（导出时弹窗选择）'}
                    </span>
                    <button
                      type="button"
                      className="ui-btn is-sm exp-btn"
                      disabled={busy}
                      onClick={() => void pickFolder()}
                    >
                      选择目录
                    </button>
                  </div>
                </section>

                {/* 导出摘要：点主按钮前先把「选了多少 / 范围 / 格式 / 去哪」核对一遍 */}
                <div className="exp-summary">
                  <div className="exp-summary-head">
                    <span className="ui-label">导出摘要</span>
                    <span className={`ui-chip is-sm${selected.size > 0 ? ' is-ok is-line' : ''}`}>
                      {selected.size > 0 ? '已就绪' : '待选择会话'}
                    </span>
                  </div>
                  <div className="exp-summary-main">
                    <span className="exp-summary-n ui-num">{selected.size}</span>
                    <span className="exp-summary-text">
                      个会话 · {RANGE_LABEL[range] ?? '全部时间'} · {FORMAT_LABEL[format]}
                    </span>
                  </div>
                  <div className="exp-summary-sub">
                    {folder ? `输出到 ${folder}` : '输出位置未选择（导出时弹窗选择目录）'}
                  </div>
                </div>

                <button
                  type="button"
                  className="ui-btn is-primary exp-btn exp-go"
                  disabled={busy || selected.size === 0}
                  onClick={() => void startChatExport()}
                >
                  {busy ? '导出中…' : `导出 ${selected.size} 个会话`}
                </button>
                {!busy && selected.size === 0 && (
                  <div className="exp-hint">还需：在左侧至少选择一个会话</div>
                )}
                {renderProgress()}
                {result && (
                  <div className="exp-result">
                    <div className="exp-result-head">
                      <span className="ui-chip is-sm is-ok is-line">
                        {result.cancelled ? '已取消' : '导出完成'}
                      </span>
                      <span className="exp-result-title">
                        {result.files.length} 个文件 · 共{' '}
                        <b className="ui-num">{result.files.reduce((n, f) => n + f.msgCount, 0)}</b>{' '}
                        条
                      </span>
                    </div>
                    {result.cancelled && <div className="exp-hint">已完成的部分保留在导出目录</div>}
                    {result.files.length > 0 && (
                      <div className="exp-result-files">
                        {result.files.slice(0, 8).map((f, i) => (
                          <div key={i} className="exp-result-file">
                            <span className="exp-result-name">{f.name}</span>
                            <span className="exp-result-n ui-num">{f.msgCount} 条</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {result.files.length > 8 && (
                      <div className="exp-hint">… 等 {result.files.length} 个文件</div>
                    )}
                    {result.skipped.length > 0 && (
                      <div className="exp-hint">
                        {result.skipped.length} 个会话{result.skipped[0]?.reason}，未生成文件：
                        {result.skipped
                          .slice(0, 5)
                          .map((s) => s.name)
                          .join('、')}
                        {result.skipped.length > 5 ? ' 等' : ''}
                      </div>
                    )}
                    <button
                      type="button"
                      className="ui-btn is-primary exp-btn"
                      onClick={() => void openFolder()}
                    >
                      打开导出目录
                    </button>
                  </div>
                )}
                {chatError && (
                  <div className="ui-err exp-error">
                    <span className="msg">{chatError}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {tab === 'biz' && (
            <div className="page-card exp-biz">
              <div className="ui-label exp-section-title">本地业务数据（JSON 归档）</div>
              <div className="exp-biz-list">
                {(
                  [
                    ['群问题', '反馈（含证据消息、状态、跟进标记）'],
                    ['发送审计', '发送审计日志 send_log'],
                    ['团队配置', '团队客服成员、智能体（人设）配置'],
                    ['账号摘要', '微信账号摘要（来源/状态，不含密钥）']
                  ] as Array<[string, string]>
                ).map(([tag, text]) => (
                  <div key={tag} className="exp-biz-item">
                    <span className="ui-chip is-sm is-line exp-biz-tag">{tag}</span>
                    <span className="exp-biz-text">{text}</span>
                  </div>
                ))}
              </div>
              <div className="exp-hint">
                该归档可在密钥/源库失效后用于回顾运营数据；文件为 JSON，可在其他机器导入查看。
              </div>
              <div className="exp-folder-row">
                <span className="exp-folder ui-num" title={folder || undefined}>
                  {folder || '未选择（导出时弹窗选择）'}
                </span>
                <button
                  type="button"
                  className="ui-btn is-sm exp-btn"
                  disabled={busy}
                  onClick={() => void pickFolder()}
                >
                  选择目录
                </button>
              </div>
              <button
                type="button"
                className="ui-btn is-primary exp-btn exp-go"
                disabled={busy}
                onClick={() => void startBizExport()}
              >
                {busy ? '导出中…' : '导出业务数据'}
              </button>
              {renderProgress()}
              {bizResult && (
                <div className="exp-result">
                  <div className="exp-result-head">
                    <span className="ui-chip is-sm is-ok is-line">导出完成</span>
                    <span className="exp-result-title exp-result-name">{bizResult}</span>
                  </div>
                  <button
                    type="button"
                    className="ui-btn is-primary exp-btn"
                    onClick={() => void openFolder()}
                  >
                    打开导出目录
                  </button>
                </div>
              )}
              {bizError && (
                <div className="ui-err exp-error">
                  <span className="msg">{bizError}</span>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default ExportPage
