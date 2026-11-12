import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getConfig } from '../db/repos/config'

/**
 * 统一日志模块(主进程)。
 * - 级别:debug < info < warn < error;作用域:按模块(im/send/ai/wb/app…)细分
 * - 存储:userData/logs/app-YYYY-MM-DD.log,跨日自动换文件,单文件超限滚动 .1
 * - 保留:仅保留最近 KEEP_DAYS 天,写入时顺手清理过期文件
 * - 内存环形尾部:REVERSE_RING 条,供设置页「日志」近实时展示(不重复读盘)
 * - 行格式:[ISO时间][LEVEL][scope] message(前缀稳定可解析,正文可含任意字符)
 * - 每个日志行同时镜像到 console(便于开发/远程复现)
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  ts: number
  level: LogLevel
  scope: string
  msg: string
  /** 所在文件名(仅读盘返回) */
  file?: string
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

let KEEP_DAYS = 7
const MAX_DAY_BYTES = 6 * 1024 * 1024
let RING_MAX = 1500

let dir = ''
let dayKey = ''
let fileSeq = 0
const ring: LogEntry[] = []
/** 当前日志文件与已写入字节数：避免每条日志都 existsSync+statSync */
let cachedPath = ''
let cachedBytes = 0

/** 读取 app_config(logs.keepDays/logs.ringMax)刷新模块参数;每次写入或设置变更时调用 */
export function reconfigureLogs(): void {
  const days = Math.floor(Number(getConfig('logs.keepDays')))
  KEEP_DAYS = Number.isFinite(days) && days >= 1 && days <= 30 ? days : 7
  const max = Math.floor(Number(getConfig('logs.ringMax')))
  RING_MAX = Number.isFinite(max) && max >= 100 && max <= 5000 ? max : 1500
  const exceed = ring.length - RING_MAX
  if (exceed > 0) ring.splice(0, exceed)
}

/** 日志保留策略(供设置页回显) */
export function logSettings(): { keepDays: number; ringMax: number } {
  return { keepDays: KEEP_DAYS, ringMax: RING_MAX }
}

function now(): Date {
  return new Date()
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function dayOf(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

/** 确保日志目录就绪并返回其绝对路径(供"打开目录"使用) */
export function ensureLogsDir(): string {
  ensureCurrentFile()
  return dir
}

function ensureCurrentFile(): void {
  const d = now()
  const key = dayOf(d)
  if (key === dayKey && dir) return
  dayKey = key
  dir = join(app.getPath('userData'), 'logs')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  fileSeq = 0
  cachedPath = ''
  cachedBytes = 0
  cleanupOld()
}

/** 清理过期日志(按文件名 app-YYYYMMDD[.n].log) */
function cleanupOld(): void {
  try {
    const threshold = dayOf(new Date(Date.now() - KEEP_DAYS * 24 * 3600_000))
    for (const name of readdirSync(dir)) {
      if (!/^app-\d{8}(\.\d+)?\.log$/.test(name)) continue
      const d = name.slice(4, 12)
      if (d < threshold) {
        try {
          rmSync(join(dir, name), { force: true })
        } catch {
          /* 忽略单个清理失败 */
        }
      }
    }
  } catch {
    /* 清理失败不影响写入 */
  }
}

/**
 * 当前文件名(app-YYYYMMDD.log;超限滚动为 .1/.2…)。
 * 用内存计数判断是否超限：只有在「首次写入/滚动后」才做一次 existsSync+statSync，
 * 否则每条日志都要 3 次同步系统调用。
 */
function currentFile(): string {
  ensureCurrentFile()
  if (cachedPath && cachedBytes < MAX_DAY_BYTES) return cachedPath
  let name = `app-${dayKey}.log`
  for (;;) {
    const p = join(dir, name)
    if (!existsSync(p)) {
      cachedPath = p
      cachedBytes = 0
      return p
    }
    const size = statSync(p).size
    if (size < MAX_DAY_BYTES) {
      cachedPath = p
      cachedBytes = size
      return p
    }
    fileSeq += 1
    name = `app-${dayKey}.${fileSeq}.log`
  }
}

function writeLine(entry: LogEntry): void {
  try {
    const d = new Date(entry.ts)
    const time = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
      d.getHours()
    )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
    const line = `[${time}][${entry.level.toUpperCase()}][${entry.scope}] ${entry.msg}\n`
    appendFileSync(currentFile(), line, 'utf8')
    cachedBytes += Buffer.byteLength(line, 'utf8')
  } catch {
    /* 日志失败绝不抛出影响业务 */
  }
}

function push(level: LogLevel, scope: string, msg: string): void {
  const entry: LogEntry = { ts: Date.now(), level, scope, msg: msg.slice(0, 8000) }
  ring.push(entry)
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX)
  writeLine(entry)
  try {
    // 镜像控制台:debug 仅非打包环境输出,info+ 始终输出
    if (level !== 'debug' || !app.isPackaged) {
      const tag = `[${level.toUpperCase()}][${scope}]`
      const text = entry.msg
      if (level === 'error') console.error(tag, text)
      else if (level === 'warn') console.warn(tag, text)
      else console.log(tag, text)
    }
  } catch {
    /* 镜像失败忽略 */
  }
}

/** 工厂:绑定作用域的 logger(建议各模块顶部 const log = createLogger('im')) */
export function createLogger(scope: string): {
  debug: (msg: string) => void
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string, err?: unknown) => void
} {
  const fmt = (msg: string, err?: unknown): string =>
    err === undefined
      ? msg
      : `${msg}: ${err instanceof Error ? `${err.message}${err.stack ? `\n${err.stack}` : ''}` : String(err)}`
  return {
    debug: (m) => push('debug', scope, m),
    info: (m) => push('info', scope, m),
    warn: (m) => push('warn', scope, m),
    error: (m, e) => push('error', scope, fmt(m, e))
  }
}

/** 内存环形尾部(近实时查询,免读盘) */
export function recentLogs(opts: {
  minLevel?: LogLevel
  scope?: string
  query?: string
  sinceMs?: number
  max?: number
}): LogEntry[] {
  const min = opts.minLevel ? LEVEL_ORDER[opts.minLevel] : 0
  const q = (opts.query ?? '').trim().toLowerCase()
  const since = typeof opts.sinceMs === 'number' && opts.sinceMs > 0 ? opts.sinceMs : 0
  const out: LogEntry[] = []
  for (let i = ring.length - 1; i >= 0; i--) {
    const e = ring[i]
    if (e.ts < since) continue
    if (LEVEL_ORDER[e.level] < min) continue
    if (opts.scope && opts.scope !== 'all' && e.scope !== opts.scope) continue
    if (q && !`${e.scope} ${e.msg}`.toLowerCase().includes(q)) continue
    out.push(e)
    if (out.length >= (opts.max ?? 500)) break
  }
  return out
}

/** 清空日志:删除历史文件并截断今日文件、清空内存尾部 */
export function clearLogs(): { removed: number } {
  let removed = 0
  try {
    ensureCurrentFile()
    for (const name of readdirSync(dir)) {
      if (!/^app-\d{8}(\.\d+)?\.log$/.test(name)) continue
      try {
        rmSync(join(dir, name), { force: true })
        removed += 1
      } catch {
        /* 单个失败继续 */
      }
    }
  } catch {
    /* 清理失败忽略 */
  }
  ring.splice(0, ring.length)
  dayKey = ''
  return { removed }
}
