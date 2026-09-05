import { app, shell } from 'electron'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { getConfig } from '../../db/repos/config'
import * as repo from '../../db/repos/imFileRepo'
import { createLogger } from '../logging'

/**
 * 渠道接收文件服务:统一管理飞书等外部渠道下载的图片/文件。
 * - 索引表 im_file_record 记录每个文件(channel/账号/发送人/相对路径/大小/时间)
 * - 清理策略:imFiles.autoClean(默认开)+ imFiles.keepDays(默认 30)
 * - 三类清理:过期文件(表内超期)、孤儿文件(目录里无登记且超期)、手动删除
 * - 防膨胀:启动/每天清理一次 + 手动「立即清理过期」
 */

const fileLog = createLogger('files')
let cleanupTimer: ReturnType<typeof setInterval> | null = null

export function fileRoot(): string {
  return join(app.getPath('userData'), 'im-files')
}

function autoCleanEnabled(): boolean {
  return getConfig('imFiles.autoClean') !== '0'
}

function keepDaysOf(): number {
  const n = Number(getConfig('imFiles.keepDays'))
  return Number.isFinite(n) && n >= 1 && n <= 365 ? Math.floor(n) : 30
}

/** 某账号的有效保留天数:账号覆盖(imFiles.keepDays.acct-<id>)优先,否则全局 */
export function keepDaysOfAccount(accountId: number): number {
  const n = Number(getConfig(`imFiles.keepDays.acct-${accountId}`))
  return Number.isFinite(n) && n >= 1 && n <= 365 ? Math.floor(n) : keepDaysOf()
}

/** 单文件接收上限字节(imFiles.maxBytes,单位 MB;0=不限;默认 50MB) */
export function maxFileBytes(): number {
  const mb = Number(getConfig('imFiles.maxBytes'))
  const safe = Number.isFinite(mb) ? mb : 50
  if (safe <= 0) return 0
  return Math.min(Math.max(Math.floor(safe), 1), 500) * 1024 * 1024
}

/** 超限提示文案(供拒收回执) */
export function maxFileHint(): string {
  const mb = maxFileBytes() / 1024 / 1024
  return `文件超过 ${mb}MB 上限,已拒收;请压缩后重试`
}

/** 绝对路径(由登记的相对路径换算,目录迁移/更名后仍可用) */
export function absOf(relPath: string): string {
  return join(fileRoot(), relPath)
}

function safeUnlink(abs: string): boolean {
  try {
    rmSync(abs, { force: true })
    return true
  } catch {
    return false
  }
}

/** 删除一组记录:先删磁盘文件(尽力),再清库;返回实际清理数 */
export function removeFiles(ids: number[]): { removed: number } {
  const rows = repo.findFileRecordsByIds(ids)
  let removed = 0
  for (const r of rows) {
    if (safeUnlink(absOf(r.relPath))) removed += 1
    else fileLog.warn(`文件删除失败或不存在: ${r.relPath}`)
  }
  repo.deleteFileRecords(rows.map((r) => r.id))
  fileLog.info(`手动删除文件 ${rows.length} 个(磁盘删除 ${removed})`)
  return { removed: rows.length }
}

/** 打开所在目录并选中文件 */
export function revealFile(id: number): boolean {
  const r = repo.findFileRecordById(id)
  if (!r) return false
  const abs = absOf(r.relPath)
  if (!existsSync(abs)) return false
  void shell.showItemInFolder(abs)
  return true
}

/** 过期清理(按各账号差异化保留天数;autoClean 关闭时返回跳过) */
export function pruneExpired(force = false): { removed: number } {
  if (!force && !autoCleanEnabled()) return { removed: 0 }
  const rows = repo.allFileRecords()
  const due: repo.FileRecordRow[] = []
  for (const r of rows) {
    const days = keepDaysOfAccount(r.accountId)
    if (Date.now() - r.createdAt >= days * 24 * 3600_000) due.push(r)
  }
  if (due.length === 0) return { removed: 0 }
  removeFiles(due.map((r) => r.id))
  fileLog.info(`过期清理:删除 ${due.length} 个(按账号保留策略)` + (force ? '[手动]' : ''))
  return { removed: due.length }
}

/** 孤儿文件 GC:目录中存在、索引无记录、且超过保留期的文件直接删除 */
export function gcOrphans(): { removed: number } {
  if (!autoCleanEnabled()) return { removed: 0 }
  const days = keepDaysOf()
  const cutoff = Date.now() - days * 24 * 3600_000
  const registered = repo.allRegisteredRelPaths()
  let removed = 0
  const root = fileRoot()
  try {
    const scan = (dir: string): void => {
      let names: string[] = []
      try {
        names = readdirSync(dir)
      } catch {
        return
      }
      for (const name of names) {
        const abs = join(dir, name)
        try {
          const st = statSync(abs)
          if (st.isDirectory()) {
            scan(abs)
            continue
          }
          if (st.mtimeMs >= cutoff) continue
          const rel = relative(root, abs).replace(/\\/g, '/')
          if (registered.has(rel)) continue
          if (safeUnlink(abs)) removed += 1
        } catch {
          /* 跳过瞬时不可读 */
        }
      }
    }
    if (existsSync(root)) scan(root)
  } catch (e) {
    fileLog.error('孤儿文件清理异常', e)
  }
  if (removed > 0) fileLog.info(`孤儿文件清理:删除 ${removed} 个`)
  return { removed }
}

/** 启动/每天定时清理(幂等:同一进程只挂一次) */
export function startFileHousekeeping(): void {
  if (cleanupTimer) return
  cleanupTimer = setInterval(() => {
    pruneExpired()
    gcOrphans()
  }, 6 * 3600_000)
  // 进程刚启动即清一轮
  setTimeout(() => {
    pruneExpired()
    gcOrphans()
  }, 8000)
}

export function stopFileHousekeeping(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer)
    cleanupTimer = null
  }
}

/** 确保目录存在(写入前) */
export function ensureFileRoot(): void {
  try {
    if (!existsSync(fileRoot())) mkdirSync(fileRoot(), { recursive: true })
  } catch {
    /* 忽略 */
  }
}

/** 当前策略(设置页回显用) */
export function filePolicy(): { autoClean: boolean; keepDays: number; maxMB: number } {
  return {
    autoClean: autoCleanEnabled(),
    keepDays: keepDaysOf(),
    maxMB: Math.floor(maxFileBytes() / 1024 / 1024)
  }
}
