import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkbenchStore } from '../stores/workbench'
import { toast } from '../stores/toast'
import type { SessionSummary } from '../../../shared/types'
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

const RANGE_PRESETS = [
  { id: 'all', label: '全部时间' },
  { id: '7', label: '近 7 天' },
  { id: '30', label: '近 30 天' },
  { id: '90', label: '近 90 天' },
  { id: 'custom', label: '自定义' }
]

function ExportPage(): React.JSX.Element {
  const wxid = useWorkbenchStore((s) => s.wxid)
  const source = useWorkbenchStore((s) => s.source)
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
  const [result, setResult] = useState<string[] | null>(null)
  const [error, setError] = useState('')
  const [bizResult, setBizResult] = useState<string | null>(null)
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

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 进入页面异步加载会话列表（回调内 setState，全仓同款模式）
    void loadSessions()
  }, [loadSessions])

  // 进度订阅
  useEffect(() => {
    const unsub = exportApi?.onProgress?.((evt) => {
      setProgress({ current: evt.current, total: evt.total, name: evt.name, detail: evt.detail })
    })
    return unsub
  }, [])

  const filtered = useMemo(() => {
    let list = sessions.filter((s) => !/^(weixin|qqmail|fmessage|medianote|filehelper|newsapp)/i.test(s.username))
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

  const pickFolder = async (): Promise<void> => {
    const r = await dialogApi?.pickDirectory('选择导出目录')
    if (r?.ok && r.path) setFolder(r.path)
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
    if (!connected || !exportApi || !folder) {
      toast.error(folder ? '未连接微信账号' : '请先选择导出目录')
      return
    }
    if (selected.size === 0) {
      toast.error('请至少选择一个会话')
      return
    }
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setResult(null)
    setError('')
    try {
      const nameOf = new Map(sessions.map((s) => [s.username, s.displayName || s.username]))
      const targets = Array.from(selected).map((u) => ({ username: u, displayName: nameOf.get(u) || u }))
      const rangeMs = resolveRangeMs()
      const res = await exportApi.chat(wxid!, {
        targets,
        format,
        folder,
        startMs: rangeMs.startMs,
        endMs: rangeMs.endMs
      })
      if (res.ok && res.files) {
        setResult(res.files.map((f) => `${f.name}（${f.msgCount} 条）`))
        toast.success(`已导出 ${res.files.length} 个会话`)
      } else {
        setError(res.error || '导出失败')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '导出失败')
    } finally {
      busyRef.current = false
      setBusy(false)
      setProgress(null)
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
      setFolder(dir)
    }
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setBizResult(null)
    setError('')
    try {
      const res = await exportApi.business(wxid!, dir)
      if (res.ok && res.name) {
        setBizResult(res.name)
        toast.success('业务数据已导出')
      } else {
        setError(res.error || '导出失败')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '导出失败')
    } finally {
      busyRef.current = false
      setBusy(false)
      setProgress(null)
    }
  }

  const openFolder = async (): Promise<void> => {
    if (folder) await exportApi?.openFolder(folder)
  }

  return (
    <div className="page-scroll exp-page">
      <h2 className="page-title">数据导出</h2>
      <div className="page-subtitle">
        导出微信会话与本地业务数据,用于留存/迁移/备份。敏感项(密钥/AI Key)一律不导出。
      </div>

      {!connected && (
        <div className="page-card exp-empty">
          尚未连接微信:请先到 设置 → 微信数据与密钥 导入密钥并连接账号后,再导出数据。
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
                className={`exp-tab${tab === id ? ' is-active' : ''}`}
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
                    className="exp-input"
                    placeholder="搜索会话名称…"
                    value={keyword}
                    onChange={(e) => setKeyword(e.target.value)}
                  />
                  <select
                    className="exp-input exp-sel"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value as SessionFilter)}
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
                      checked={filtered.length > 0 && filtered.every((s) => selected.has(s.username))}
                      onChange={toggleAll}
                    />
                    全选（{filtered.length}）
                  </label>
                  <button
                    type="button"
                    className="exp-link"
                    disabled={busy}
                    onClick={() => setSelected(new Set())}
                  >
                    清空
                  </button>
                  <button type="button" className="exp-link" disabled={busy} onClick={() => void loadSessions()}>
                    刷新
                  </button>
                </div>
                <div className="exp-sess-list">
                  {loadingSessions && <div className="exp-empty">加载中…</div>}
                  {!loadingSessions && filtered.length === 0 && (
                    <div className="exp-empty">没有可导出的会话</div>
                  )}
                  {filtered.map((s) => {
                    const name = s.displayName || s.nickname || s.remark || s.username
                    return (
                      <label key={s.username} className={`exp-sess-row${selected.has(s.username) ? ' is-on' : ''}`}>
                        <input
                          type="checkbox"
                          checked={selected.has(s.username)}
                          onChange={() => toggleOne(s.username)}
                        />
                        <span className="exp-sess-main">
                          <span className="exp-sess-name">
                            {s.isGroup && <i className="exp-tag">群</i>}
                            {s.isOfficialAccount && <i className="exp-tag">公众号</i>}
                            {name}
                          </span>
                          <span className="exp-sess-sub">{s.username}</span>
                        </span>
                      </label>
                    )
                  })}
                </div>
              </div>

              {/* 右:选项与执行 */}
              <div className="page-card exp-opts">
                <div className="exp-section-title">时间范围</div>
                <div className="exp-pill-row">
                  {RANGE_PRESETS.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      className={`exp-pill${range === r.id ? ' is-on' : ''}`}
                      onClick={() => setRange(r.id)}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
                {range === 'custom' && (
                  <div className="exp-date-row">
                    <input type="date" className="exp-input" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                    <span>至</span>
                    <input type="date" className="exp-input" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
                  </div>
                )}

                <div className="exp-section-title">格式</div>
                <div className="exp-pill-row">
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
                      className={`exp-pill${format === id ? ' is-on' : ''}`}
                      onClick={() => setFormat(id)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="exp-hint">附件本体不包含在导出中(消息记录其 md5/文件名引用);TXT 适合阅读,JSON 保留结构化字段便于未来导入。</div>

                <div className="exp-section-title">导出位置</div>
                <div className="exp-folder-row">
                  <span className="exp-folder">{folder || '未选择'}</span>
                  <button type="button" className="exp-btn ghost" onClick={() => void pickFolder()}>
                    选择目录
                  </button>
                </div>

                <button
                  type="button"
                  className="exp-btn primary exp-go"
                  disabled={busy || selected.size === 0 || !folder}
                  onClick={() => void startChatExport()}
                >
                  {busy ? '导出中…' : `导出 ${selected.size} 个会话`}
                </button>
                {progress && (
                  <div className="exp-progress">
                    <div className="exp-progress-text">
                      正在导出 {progress.name}（{progress.current}/{progress.total}）· {progress.detail}
                    </div>
                    <div className="exp-bar">
                      <div
                        className="exp-bar-in"
                        style={{ width: `${(progress.current / Math.max(1, progress.total)) * 100}%` }}
                      />
                    </div>
                  </div>
                )}
                {result && result.length > 0 && (
                  <div className="exp-result">
                    <div className="exp-result-title">✓ 导出完成({result.length} 个文件):</div>
                    {result.slice(0, 8).map((f, i) => (
                      <div key={i} className="exp-result-file">
                        {f}
                      </div>
                    ))}
                    {result.length > 8 && <div>… 等 {result.length} 个</div>}
                    <button type="button" className="exp-link" onClick={() => void openFolder()}>
                      打开导出目录
                    </button>
                  </div>
                )}
                {error && <div className="exp-error">{error}</div>}
              </div>
            </div>
          )}

          {tab === 'biz' && (
            <div className="page-card exp-biz">
              <div className="exp-section-title">本地业务数据(JSON 归档)</div>
              <div className="exp-biz-list">
                <div>· 群问题反馈(含证据消息、状态、跟进标记)</div>
                <div>· 发送审计日志(send_log)</div>
                <div>· 团队客服成员、智能体(人设)配置</div>
                <div>· 微信账号摘要(来源/状态,不含密钥)</div>
              </div>
              <div className="exp-hint">该归档可在密钥/源库失效后用于回顾运营数据;文件为 JSON,可在其他机器导入查看。</div>
              <div className="exp-folder-row">
                <span className="exp-folder">{folder || '未选择(导出时弹窗选择)'}</span>
                <button type="button" className="exp-btn ghost" onClick={() => void pickFolder()}>
                  选择目录
                </button>
              </div>
              <button
                type="button"
                className="exp-btn primary exp-go"
                disabled={busy}
                onClick={() => void startBizExport()}
              >
                {busy ? '导出中…' : '导出业务数据'}
              </button>
              {progress && (
                <div className="exp-progress">
                  <div className="exp-progress-text">
                    正在导出 {progress.name} · {progress.detail}
                  </div>
                </div>
              )}
              {bizResult && (
                <div className="exp-result">
                  <div className="exp-result-title">✓ 已生成 {bizResult}</div>
                  <button type="button" className="exp-link" onClick={() => void openFolder()}>
                    打开导出目录
                  </button>
                </div>
              )}
              {error && <div className="exp-error">{error}</div>}
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default ExportPage
