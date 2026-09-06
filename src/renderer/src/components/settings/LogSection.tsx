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
const configApi = window.api?.cs?.config
const LEVELS = ['全部', 'error', 'warn', 'info'] as const
const SCOPE_ALL = '__all__'
const HOUR_MS = 3600_000

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
  const [auto, setAuto] = useState(false)
  const [hourOnly, setHourOnly] = useState(false)
  const [keepDays, setKeepDays] = useState(7)
  const [ringMax, setRingMax] = useState(1500)
  const [loading, setLoading] = useState(false)
  const qRef = useRef('')
  const lastTsRef = useRef<number | undefined>(undefined)

  // 初始回显日志策略与自动刷新偏好(app_config;自动刷新默认关闭,避免常驻定时刷新占性能)
  useEffect(() => {
    void configApi?.getAll().then((cfg) => {
      const d = Number(cfg['logs.keepDays'])
      const m = Number(cfg['logs.ringMax'])
      if (Number.isFinite(d) && d >= 1 && d <= 30) setKeepDays(Math.floor(d))
      if (Number.isFinite(m) && m >= 100 && m <= 5000) setRingMax(Math.floor(m))
      setAuto(cfg['logs.autoRefresh'] === '1')
    })
  }, [])

  // 偏好持久化(切页/重启后保持手动关闭状态)
  useEffect(() => {
    void configApi?.set('logs.autoRefresh', auto ? '1' : '0')
  }, [auto])

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const res = await logApi
        ?.recent({
          minLevel: level === '全部' ? 'debug' : (level as 'error' | 'warn' | 'info'),
          scope: scope === SCOPE_ALL ? undefined : scope,
          query: qRef.current.trim() || undefined,
          sinceMs: hourOnly ? Date.now() - HOUR_MS : undefined,
          max: 800
        })
        .catch(() => null)
      if (res?.ok && res.entries) {
        const list = res.entries as LogRow[]
        setRows(list)
        lastTsRef.current = list.length > 0 ? list[0].ts : undefined
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
  }, [hourOnly, level, scope])

  /** 自动刷新采用增量:只取上次之后的新行并合并,避免每 3s 全量拉取重渲染 */
  const tickAuto = useCallback(async (): Promise<void> => {
    const last = lastTsRef.current
    if (last === undefined) {
      await load()
      return
    }
    const res = await logApi
      ?.recent({
        minLevel: level === '全部' ? 'debug' : (level as 'error' | 'warn' | 'info'),
        scope: scope === SCOPE_ALL ? undefined : scope,
        query: qRef.current.trim() || undefined,
        sinceMs: last,
        max: 400
      })
      .catch(() => null)
    if (res?.ok && res.entries) {
      const list = res.entries as LogRow[]
      if (list.length === 0) return
      setRows((prev) => {
        const merged = [...list, ...(prev ?? []).filter((r) => r.ts <= last)]
          .sort((a, b) => b.ts - a.ts)
          .slice(0, 800)
        return merged
      })
      lastTsRef.current = list[0].ts
    }
  }, [level, scope, load])

  // 自动刷新(3s,增量);默认关闭;仅在 tab 挂载期间运行
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 挂载即拉取首批日志(全仓同款模式)
    void load()
    if (!auto) return
    const timer = window.setInterval(() => {
      void tickAuto()
    }, 3000)
    return () => window.clearInterval(timer)
  }, [auto, load, tickAuto])

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

  const linesOf = (list: LogRow[]): string =>
    list.map((r) => `[${fmtTime(r.ts)}][${r.level.toUpperCase()}][${r.scope}] ${r.msg}`).join('\n')

  const copyAll = async (): Promise<void> => {
    const list = rows ?? []
    if (list.length === 0) return toast.error('当前没有可复制的日志')
    void navigator.clipboard
      .writeText(linesOf(list))
      .then(() => toast.success(`已复制 ${list.length} 条日志`))
      .catch(() => toast.error('复制失败'))
  }

  const exportFile = async (): Promise<void> => {
    const list = rows ?? []
    if (list.length === 0) return toast.error('当前没有可导出的日志')
    const d = new Date()
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(
      d.getDate()
    ).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(
      2,
      '0'
    )}`
    const blob = new Blob([`${linesOf(list)}\n`], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `app-logs-${stamp}.log`
    document.body.appendChild(a)
    a.click()
    a.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 2000)
    toast.success(`已导出 ${list.length} 条日志`)
  }

  /** 应用保留天数/内存条数(即时生效,无需重启) */
  const savePolicy = async (): Promise<void> => {
    const d = Math.min(Math.max(Math.floor(keepDays) || 7, 1), 30)
    const m = Math.min(Math.max(Math.floor(ringMax) || 1500, 100), 5000)
    setKeepDays(d)
    setRingMax(m)
    await Promise.all([
      configApi?.set('logs.keepDays', String(d)),
      configApi?.set('logs.ringMax', String(m))
    ])
    const r = await logApi?.applyConfig().catch(() => null)
    toast.success(r?.ok ? '日志策略已应用' : (r?.error ?? '策略应用失败'))
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
        <label className="lg-auto">
          <input
            type="checkbox"
            checked={hourOnly}
            onChange={(e) => setHourOnly(e.target.checked)}
          />
          仅最近 1 小时
        </label>
        <label className="lg-auto">
          <input
            type="checkbox"
            checked={auto}
            onChange={(e) => setAuto(e.target.checked)}
            title="开启后每 3 秒增量拉取新日志(仅合并新增行,不整表重载)"
          />
          自动刷新(3s)
        </label>
        {!auto && <span className="lg-auto-hint">已暂停 · 无定时刷新,查看请点「刷新」</span>}
        <button type="button" className="st-btn ghost" onClick={() => void copyAll()}>
          复制结果
        </button>
        <button type="button" className="st-btn ghost" onClick={() => void exportFile()}>
          导出文件
        </button>
        <button type="button" className="st-btn ghost" onClick={() => void openFolder()}>
          打开日志目录
        </button>
        <button type="button" className="st-btn ghost danger" onClick={() => void clearLogs()}>
          清空日志
        </button>
      </div>

      <div className="lg-policy">
        保留天数
        <input
          className="st-input lg-num"
          type="number"
          min={1}
          max={30}
          value={keepDays}
          onChange={(e) => setKeepDays(Number(e.target.value))}
        />
        内存缓存条数
        <input
          className="st-input lg-num"
          type="number"
          min={100}
          max={5000}
          step={100}
          value={ringMax}
          onChange={(e) => setRingMax(Number(e.target.value))}
        />
        <button type="button" className="st-btn ghost sm" onClick={() => void savePolicy()}>
          应用策略
        </button>
        <span className="lg-meta">按日文件保留天数与内存尾部条数,即时生效无需重启</span>
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
