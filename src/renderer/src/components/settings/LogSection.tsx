import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from '../../stores/toast'

/**
 * 设置 → 日志:近实时查看主进程统一日志(内存尾部),支持级别/作用域/关键字过滤,
 * 以及 打开日志目录 / 清空日志 操作。日志文件按日落在 userData/logs/ 并保留 7 天。
 */

interface LogRow {
  ts: number
  level: string
  scope: string
  msg: string
}

const logApi = window.api?.cs?.logs
const LEVELS = ['全部', 'error', 'warn', 'info'] as const
const SCOPE_ALL = '__all__'

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(
    d.getSeconds()
  )}`
}

export function LogSection(): React.JSX.Element {
  const [rows, setRows] = useState<LogRow[] | null>(null)
  const [level, setLevel] = useState<string>('info')
  const [scope, setScope] = useState<string>(SCOPE_ALL)
  const [scopes, setScopes] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [auto, setAuto] = useState(true)
  const [loading, setLoading] = useState(false)
  const qRef = useRef('')

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const res = await logApi
        ?.recent({
          minLevel: level === '全部' ? 'debug' : (level as 'error' | 'warn' | 'info'),
          scope: scope === SCOPE_ALL ? undefined : scope,
          query: qRef.current.trim() || undefined,
          max: 800
        })
        .catch(() => null)
      if (res?.ok && res.entries) {
        const list = res.entries as LogRow[]
        setRows(list)
        setScopes((prev) => {
          const set = new Set(prev)
          for (const r of list) if (r.scope) set.add(r.scope)
          return [...set].sort()
        })
      } else {
        setRows((prev) => prev ?? [])
      }
    } finally {
      setLoading(false)
    }
  }, [level, scope])

  // 自动刷新(3s);仅在 tab 挂载期间运行
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 挂载即拉取首批日志(全仓同款模式)
    void load()
    if (!auto) return
    const timer = window.setInterval(() => {
      void load()
    }, 3000)
    return () => window.clearInterval(timer)
  }, [auto, load])

  // 关键字防抖
  useEffect(() => {
    qRef.current = query
    const t = window.setTimeout(() => void load(), 320)
    return () => window.clearTimeout(t)
  }, [query, load])

  const openFolder = async (): Promise<void> => {
    const res = await logApi?.openFolder().catch(() => null)
    if (res && !res.ok) toast.error(res.error || '打开失败')
  }

  const clearLogs = async (): Promise<void> => {
    if (!window.confirm('清空全部日志文件与内存记录(含今日)?一般仅在排查后确认无用才清理。')) return
    const res = await logApi?.clear().catch(() => null)
    if (res?.ok) {
      toast.success('日志已清空')
      void load()
    } else {
      toast.error((res as { error?: string } | null)?.error || '清理失败')
    }
  }

  const copyMsg = (r: LogRow): void => {
    const line = `[${fmtTime(r.ts)}][${r.level.toUpperCase()}][${r.scope}] ${r.msg}`
    void navigator.clipboard
      .writeText(line)
      .then(() => toast.success('已复制该条日志'))
      .catch(() => toast.error('复制失败'))
  }

  return (
    <div className="lg-root">
      <div className="lg-toolbar">
        <select
          className="st-input lg-sel"
          value={level}
          onChange={(e) => setLevel(e.target.value)}
          title="最低级别过滤"
        >
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {l === '全部' ? '全部级别' : `仅 ${l.toUpperCase()}`}
            </option>
          ))}
        </select>
        <select
          className="st-input lg-sel"
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          title="按模块过滤"
        >
          <option value={SCOPE_ALL}>全部模块</option>
          {scopes.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input
          className="st-input lg-query"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="关键字过滤(如 message_id / 失败 / acct=1)"
          spellCheck={false}
        />
        <button
          type="button"
          className="st-btn ghost"
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? '读取中…' : '刷新'}
        </button>
        <button type="button" className="st-btn ghost" onClick={() => void openFolder()}>
          打开日志目录
        </button>
        <button type="button" className="st-btn ghost danger" onClick={() => void clearLogs()}>
          清空日志
        </button>
        <label className="lg-auto">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          自动刷新(3s)
        </label>
      </div>

      <div className="lg-meta">
        内存尾部共 {rows?.length ?? 0} 条(最近新在上)· 落盘文件:
        userData/logs/app-YYYYMMDD.log,按日滚动、保留 {7} 天 · 点击任意行复制该条
      </div>

      <div className="lg-list" role="log">
        {rows === null && <div className="st-hint">加载中…</div>}
        {rows !== null && rows.length === 0 && (
          <div className="st-hint">没有匹配的日志(可能是新启动尚无输出,或过滤条件过严)。</div>
        )}
        {rows?.map((r, i) => (
          <button
            type="button"
            key={`${r.ts}-${i}`}
            className="lg-row"
            title="点击复制该条日志"
            onClick={() => copyMsg(r)}
          >
            <span className="lg-time">{fmtTime(r.ts)}</span>
            <span className={`lg-lv is-${r.level}`}>{r.level.toUpperCase()}</span>
            <span className="lg-scope">{r.scope}</span>
            <span className="lg-msg">{r.msg}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
