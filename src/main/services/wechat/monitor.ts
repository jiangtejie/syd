import { statSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { findMsgDbFiles, findSessionDbFile } from './dbLocator'
import { isWalOf, logicalDbFileOf, watchedDbFiles } from './dbFileWatch'

/**
 * 微信库监控桥（T5，自研实现）。
 *
 * 方案：fs.watch 监听消息库目录 + 定时轮询兜底（stat mtime/size）。
 * 微信 4.x 库文件在运行期是"活的"，登录后约 1.5 分钟会整库重写；
 * 监控只负责"检测到变化"，具体读库逻辑由调用方按需触发（读前需等库落定）。
 */

export interface DbChangeInfo {
  /** 变化的库文件绝对路径 */
  changedFiles: string[]
  /** 是否包含会话库（影响会话列表刷新） */
  sessionChanged: boolean
}

const DEBOUNCE_MS = 500
const POLL_MS = 2000
/**
 * WAL 变化的通知冷却（每个库文件）。
 *
 * 微信活跃时 WAL 几乎一直在追加，2s 轮询会每次都判成「变了」——不节流就是每 2 秒
 * 轰一次 dbChanged，把下游（会话列表重读、议题增量提取、界面刷新）全部叫起来。
 * 主库自身的变化不受此限（那是真事件，立刻通知）。
 */
const WAL_NOTIFY_COOLDOWN_MS = 3000

export interface DbMonitorOptions {
  /** 轮询间隔（默认 2000ms） */
  pollIntervalMs?: number
}

interface FileStamp {
  mtimeMs: number
  size: number
}

export class WeChatDbMonitor {
  private dbStoragePath: string
  private sessionDbPath: string | null
  private msgDbPaths: string[]
  private watchers: FSWatcher[] = []
  private pollTimer: NodeJS.Timeout | null = null
  private debounceTimer: NodeJS.Timeout | null = null
  private pendingChanges = new Set<string>()
  private stamps = new Map<string, FileStamp>()
  /** WAL 变化的上次通知时刻（按库文件）：见 WAL_NOTIFY_COOLDOWN_MS */
  private walNotifiedAt = new Map<string, number>()
  private stopped = false

  constructor(
    dbStoragePath: string,
    private opts: DbMonitorOptions = {}
  ) {
    this.dbStoragePath = dbStoragePath.replace(/[\\/]+$/, '')
    this.sessionDbPath = findSessionDbFile(this.dbStoragePath)
    this.msgDbPaths = findMsgDbFiles(this.dbStoragePath)
  }

  /** 启动监控 */
  start(onChange: (info: DbChangeInfo) => void): void {
    // 记录初始快照（含 -wal：新鲜度判定本来就把它算作「源变了」，这里口径对齐）
    for (const file of this.watchedFiles()) {
      const s = this.stamp(file)
      if (s) this.stamps.set(file, s)
    }

    // fs.watch：监听消息库与 session 目录（递归不可靠，改监听目标文件所在目录）
    const dirs = new Set<string>()
    for (const file of this.allFiles()) {
      dirs.add(this.dirOf(file))
    }
    for (const dir of dirs) {
      try {
        const watcher = watch(dir, (_eventType, filename) => {
          if (!filename) return
          this.noteChange(this.resolveInDir(dir, filename), onChange)
        })
        this.watchers.push(watcher)
      } catch {
        /* 目录不存在或权限不足，靠轮询兜底 */
      }
    }

    // 轮询兜底：stat 对比 mtime/size
    const pollMs = this.opts.pollIntervalMs ?? POLL_MS
    this.pollTimer = setInterval(() => {
      if (this.stopped) return
      for (const file of this.watchedFiles()) {
        const current = this.stamp(file)
        const prev = this.stamps.get(file)
        if (prev && current && (current.mtimeMs !== prev.mtimeMs || current.size !== prev.size)) {
          this.stamps.set(file, current)
          this.noteChange(file, onChange)
        } else if (!prev && current) {
          this.stamps.set(file, current)
          this.noteChange(file, onChange)
        }
      }
    }, pollMs)
  }

  /** 停止监控 */
  stop(): void {
    this.stopped = true
    for (const w of this.watchers) {
      try {
        w.close()
      } catch {
        /* ignore */
      }
    }
    this.watchers = []
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.pollTimer = null
    this.debounceTimer = null
  }

  private allFiles(): string[] {
    const files = [...this.msgDbPaths]
    if (this.sessionDbPath) files.push(this.sessionDbPath)
    return files
  }

  private stamp(file: string): FileStamp | null {
    try {
      const st = statSync(file)
      return { mtimeMs: st.mtimeMs, size: st.size }
    } catch {
      return null
    }
  }

  private dirOf(file: string): string {
    const idx = file.replace(/\\/g, '/').lastIndexOf('/')
    return idx >= 0 ? file.slice(0, idx) : file
  }

  private resolveInDir(dir: string, filename: string): string {
    return join(dir, filename)
  }

  /** 库文件 + 各自的 -wal：WAL 追加写入也算「库变了」 */
  private watchedFiles(): string[] {
    return watchedDbFiles(this.allFiles())
  }

  /**
   * 记一次变化。对外只报**库文件本身**（-wal 归一到它的库文件）：
   * 下游按路径判 sessionChanged、按文件触发读库，混进 -wal 会全部失配。
   * WAL 变化按 WAL_NOTIFY_COOLDOWN_MS 节流；主库变化立即放行。
   */
  private noteChange(file: string, onChange: (info: DbChangeInfo) => void): void {
    const logical = logicalDbFileOf(file, this.allFiles())
    if (!logical) return
    if (isWalOf(file, this.allFiles())) {
      const now = Date.now()
      const last = this.walNotifiedAt.get(logical) ?? 0
      if (now - last < WAL_NOTIFY_COOLDOWN_MS) return
      this.walNotifiedAt.set(logical, now)
    }
    this.queueChange(logical, onChange)
  }

  private queueChange(file: string, onChange: (info: DbChangeInfo) => void): void {
    this.pendingChanges.add(file)
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      if (this.stopped || this.pendingChanges.size === 0) return
      const changedFiles = [...this.pendingChanges]
      this.pendingChanges.clear()
      const sessionChanged = changedFiles.some(
        (f) =>
          this.sessionDbPath &&
          f.replace(/\\/g, '/').toLowerCase() ===
            this.sessionDbPath!.replace(/\\/g, '/').toLowerCase()
      )
      onChange({ changedFiles, sessionChanged })
    }, DEBOUNCE_MS)
  }
}
