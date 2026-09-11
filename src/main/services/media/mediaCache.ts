import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { getConfig, getConfigNumber } from '../../db/repos/config'
import { getMediaArchiveDir, getMediaRootDir } from '../paths'
import { createLogger } from '../logging'
import { planMediaPrune, type MediaCacheEntry } from './mediaCachePolicy'
import { pruneVoiceCache } from './voice'

const mediaLog = createLogger('media')

/**
 * 媒体缓存（`<cache>/media/<账号>/`）的容量治理。
 *
 * 为什么需要：这个目录此前只增不减 —— 图片/视频解密产物、表情缓存会随着使用无限堆积；
 * 而语音（`voices/`）与上报归档（`archive/`）各自独立：前者有自己的淘汰，后者是用户数据不能删。
 *
 * 淘汰只针对「可再生」的文件（解密产物 + 已无人读取的遗留命名），归档与不认识的文件一律不动；
 * 年龄是软上限（默认 180 天），容量是硬上限（默认 8GB / 5 万文件）—— 超了才按最旧削。
 */

/** 默认策略：保留久一点（半年）、容量给足（8GB/5 万文件），避免把还能用的缓存清掉 */
export const MEDIA_CACHE_DEFAULTS = { keepDays: 180, maxMB: 8192, maxFiles: 50000 } as const

export function mediaAutoCleanEnabled(): boolean {
  return getConfig('wechat.mediaCacheAutoClean') !== '0'
}

export function mediaCachePolicy(): {
  autoClean: boolean
  keepDays: number
  maxMB: number
  maxFiles: number
} {
  return {
    autoClean: mediaAutoCleanEnabled(),
    keepDays: Math.max(
      0,
      getConfigNumber('wechat.mediaCacheKeepDays', MEDIA_CACHE_DEFAULTS.keepDays)
    ),
    maxMB: Math.max(0, getConfigNumber('wechat.mediaCacheMaxMB', MEDIA_CACHE_DEFAULTS.maxMB)),
    maxFiles: Math.max(
      0,
      getConfigNumber('wechat.mediaCacheMaxFiles', MEDIA_CACHE_DEFAULTS.maxFiles)
    )
  }
}

function dirEntries(dir: string): MediaCacheEntry[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        const full = join(dir, e.name)
        const st = statSync(full)
        return { name: e.name, size: st.size, mtimeMs: st.mtimeMs }
      })
  } catch {
    return []
  }
}

/** 账号目录列表：`<cache>/media/<wxid>`（只取目录，忽略散落文件） */
function accountDirs(): string[] {
  const root = getMediaRootDir()
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(root, e.name))
  } catch {
    return []
  }
}

/** 账号 wxid 列表（语音缓存淘汰按账号进行） */
function accountNames(): string[] {
  try {
    return readdirSync(getMediaRootDir(), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}

export interface MediaCacheStats {
  /** 展示缓存：文件数 / 字节（不含 archive 与 voices 子目录） */
  files: number
  bytes: number
  /** 上报归档字节（用户数据，不参与淘汰） */
  archiveBytes: number
  /** 归档文件数 */
  archiveFiles: number
}

/** 缓存现状（设置页回显 + 清理前后对比用） */
export function mediaCacheStats(): MediaCacheStats {
  let files = 0
  let bytes = 0
  let archiveBytes = 0
  let archiveFiles = 0
  for (const dir of accountDirs()) {
    for (const e of dirEntries(dir)) {
      files += 1
      bytes += e.size
    }
    const wxid = dir.split(/[\\/]/).pop() ?? ''
    if (!wxid) continue
    for (const e of dirEntries(getMediaArchiveDir(wxid))) {
      archiveFiles += 1
      archiveBytes += e.size
    }
  }
  return { files, bytes, archiveBytes, archiveFiles }
}

export interface MediaPruneResult {
  /** 实际删除的文件数 */
  removed: number
  freedBytes: number
  /** 扫描过的文件数（含受保护未删的） */
  scanned: number
  /** 受策略保护的文件数（归档 / 不认识） */
  protectedFiles: number
  /** 因超容量被削掉的（年龄之外的硬上限部分） */
  trimmedBySize: number
  /** autoClean 关闭且未强制时跳过 */
  skipped?: boolean
}

/** 清理媒体展示缓存：年龄 + 容量双约束（force=true 时忽略自动清理开关） */
export function pruneMediaCache(force = false): MediaPruneResult {
  const out: MediaPruneResult = {
    removed: 0,
    freedBytes: 0,
    scanned: 0,
    protectedFiles: 0,
    trimmedBySize: 0
  }
  if (!force && !mediaAutoCleanEnabled()) return { ...out, skipped: true }
  const policy = mediaCachePolicy()
  for (const dir of accountDirs()) {
    const entries = dirEntries(dir)
    if (entries.length === 0) continue
    out.scanned += entries.length
    const plan = planMediaPrune(entries, {
      keepDays: policy.keepDays,
      maxBytes: policy.maxMB * 1024 * 1024,
      maxFiles: policy.maxFiles
    })
    out.protectedFiles += plan.keptProtected
    out.trimmedBySize += plan.trimmedBySize
    // 用真实文件大小记账：删除可能失败（文件被 <img>/<video> 占用），失败的不该算进回收量
    const sizeOf = new Map(entries.map((e) => [e.name, e.size]))
    for (const name of plan.remove) {
      const full = join(dir, name)
      try {
        unlinkSync(full) // 被 <img>/<video> 占用的会失败：下轮再试
        out.removed += 1
        out.freedBytes += sizeOf.get(name) ?? 0
      } catch {
        /* 占用/权限：跳过 */
      }
    }
  }
  if (out.removed > 0) {
    const freed =
      out.freedBytes >= 1024 * 1024
        ? Math.round(out.freedBytes / 1024 / 1024) + 'MB'
        : Math.max(1, Math.round(out.freedBytes / 1024)) + 'KB'
    mediaLog.info(
      '媒体缓存清理:删除 ' +
        out.removed +
        ' 个/' +
        freed +
        '（保留 ' +
        policy.keepDays +
        ' 天，上限 ' +
        policy.maxMB +
        'MB/' +
        policy.maxFiles +
        ' 个）'
    )
  }
  return out
}
/** 语音缓存淘汰（按账号；与媒体展示缓存同一套定时器） */
export function pruneAllVoiceCaches(): { removed: number; freedBytes: number } {
  const out = { removed: 0, freedBytes: 0 }
  for (const wxid of accountNames()) {
    const r = pruneVoiceCache(wxid)
    out.removed += r.removed
    out.freedBytes += r.freedBytes
  }
  return out
}

let housekeepingTimer: NodeJS.Timeout | null = null

/**
 * 启动媒体侧的后台治理（进程内只挂一次）：
 * - 启动后延迟跑一轮（等托盘/窗口先起来），之后每 6 小时一轮；
 * - 每轮：媒体展示缓存淘汰（年龄+容量）+ 语音缓存淘汰；
 * - 归档目录迁移只在这里做一次（配置门控 + 幂等，非破坏：只复制不删除）。
 */
export function startMediaHousekeeping(): void {
  if (housekeepingTimer) return
  const runOnce = (): void => {
    try {
      pruneMediaCache()
      pruneAllVoiceCaches()
    } catch (e) {
      mediaLog.warn(`媒体缓存清理异常: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  housekeepingTimer = setInterval(runOnce, 6 * 3600_000)
  setTimeout(runOnce, 15_000)
}

export function stopMediaHousekeeping(): void {
  if (housekeepingTimer) {
    clearInterval(housekeepingTimer)
    housekeepingTimer = null
  }
}
