import { app, shell } from 'electron'
import { existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { getConfig } from '../../db/repos/config'
import * as repo from '../../db/repos/imFileRepo'
import { getFilesRootDir } from '../paths'
import { createLogger } from '../logging'

/**
 * 渠道接收文件服务:统一管理飞书等外部渠道下载的图片/文件。
 * - 存放于缓存目录 files 分区(<cache>/files),随「清理缓存/更换缓存目录」统一管理
 * - 索引表 im_file_record 记录每个文件(channel/账号/发送人/相对路径/大小/时间)
 * - 清理策略:imFiles.autoClean(默认开)+ imFiles.keepDays(默认 30)
 * - 三类清理:过期文件(表内超期)、孤儿文件(目录里无登记且超期)、手动删除
 * - 防膨胀:启动/每天清理一次 + 手动「立即清理过期」
 */

const fileLog = createLogger('files')
let cleanupTimer: ReturnType<typeof setInterval> | null = null

/** 渠道接收文件根:缓存目录 files 分区(随用户配置的缓存目录走) */
export function fileRoot(): string {
  return getFilesRootDir()
}

/**
 * 历史布局迁移:旧版本文件在 userData/im-files,
 * 新版统一迁入缓存目录 files 分区(相对路径不变,索引无需改动)。
 */
export function migrateLegacyChannelFiles(): void {
  try {
    const legacy = join(app.getPath('userData'), 'im-files')
    const target = getFilesRootDir()
    if (!existsSync(legacy)) return
    if (!existsSync(target)) {
      renameSync(legacy, target)
      fileLog.info(`渠道文件目录已迁移:userData/im-files -> ${target}`)
      return
    }
    // 目标已存在(部分新文件已写入):逐个搬入,重名跳过,最后尝试删除旧目录
    let moved = 0
    for (const name of readdirSync(legacy)) {
      const from = join(legacy, name)
      const to = join(target, name)
      if (!existsSync(to)) {
        renameSync(from, to)
        moved += 1
      }
    }
    if (moved > 0) fileLog.info(`渠道文件合并迁移 ${moved} 项到 ${target}`)
    rmSync(legacy, { recursive: true, force: true })
  } catch (e) {
    fileLog.warn(
      `渠道文件目录迁移失败(下次启动重试): ${e instanceof Error ? e.message : String(e)}`
    )
  }
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
  // 账号数很少:保留天数按账号缓存一次,避免每条文件记录都读一次 app_config
  const daysByAccount = new Map<number, number>()
  const now = Date.now()
  for (const r of rows) {
    let days = daysByAccount.get(r.accountId)
    if (days === undefined) {
      days = keepDaysOfAccount(r.accountId)
      daysByAccount.set(r.accountId, days)
    }
    if (now - r.createdAt >= days * 24 * 3600_000) due.push(r)
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
  // 迁移历史 userData/im-files → 缓存 files 分区
  try {
    migrateLegacyChannelFiles()
  } catch {
    /* 迁移内部已容错 */
  }
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

/** 当前策略(设置页回显用) */
export function filePolicy(): { autoClean: boolean; keepDays: number; maxMB: number } {
  return {
    autoClean: autoCleanEnabled(),
    keepDays: keepDaysOf(),
    maxMB: Math.floor(maxFileBytes() / 1024 / 1024)
  }
}
