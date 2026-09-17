import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { getConfigNumber } from '../../db/repos/config'
import { isInjectShot, shouldPruneInjectShot } from '../securityPolicy'
import { createLogger } from '../logging'

const shotLog = createLogger('inject')

/**
 * 注入截图目录：<userData>/inject-shots（与 injector.ts 写的是同一个目录）。
 */
export function injectShotDir(): string {
  return join(app.getPath('userData'), 'inject-shots')
}

/**
 * 注入截图治理。
 *
 * 为什么需要：截图里是**完整的客户会话界面**（含客户名、聊天内容、群名），而它此前
 * 无保留期、无清理、退出也不清 —— 实测一台机器上常驻 6 张 4.8MB。这是比明文库副本更
 * 直白的泄露面：任何能读这台机器磁盘的人，不需要密钥就能看到客户聊天画面。
 *
 * 只在**注入发生**时才会新增，所以启动清一轮 + 每 6 小时一轮就够了。
 */
export interface ShotsPruneResult {
  removed: number
  freedBytes: number
  kept: number
}

const KEEP_DAYS_KEY = 'wechat.injectShotsKeepDays'
const KEEP_FILES_KEY = 'wechat.injectShotsKeepFiles'
/** 默认保留 3 天 / 最多 20 张：排查最近的发送问题够用，再久的截图没有价值只有风险 */
const DEFAULT_KEEP_DAYS = 3
const DEFAULT_KEEP_FILES = 20

function listShots(): Array<{ name: string; full: string; size: number; mtimeMs: number }> {
  const dir = injectShotDir()
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        const full = join(dir, e.name)
        const st = statSync(full)
        return { name: e.name, full, size: st.size, mtimeMs: st.mtimeMs }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
  } catch {
    return []
  }
}

export function injectShotsStats(): { count: number; bytes: number } {
  const all = listShots().filter((f) => isInjectShot(f.name))
  return { count: all.length, bytes: all.reduce((s, f) => s + f.size, 0) }
}

/** 按保留期/数量清理注入截图（非截图不动） */
export function pruneInjectShots(): ShotsPruneResult {
  const out: ShotsPruneResult = { removed: 0, freedBytes: 0, kept: 0 }
  const keepDays = getConfigNumber(KEEP_DAYS_KEY, DEFAULT_KEEP_DAYS)
  const keepFiles = getConfigNumber(KEEP_FILES_KEY, DEFAULT_KEEP_FILES)
  const now = Date.now()
  let index = 0
  for (const f of listShots()) {
    const shot = isInjectShot(f.name)
    const shouldDelete = shouldPruneInjectShot({
      name: f.name,
      ageMs: now - f.mtimeMs,
      keepDays,
      index,
      keepFiles
    })
    if (shot) index += 1
    if (!shouldDelete) {
      if (shot) out.kept += 1
      continue
    }
    try {
      unlinkSync(f.full)
      out.removed += 1
      out.freedBytes += f.size
    } catch {
      /* 被占用：下轮再试 */
    }
  }
  return out
}

/** 退出即清（默认开）：截图只是当次排查用的中间产物，没有留到下次启动的理由 */
export function clearInjectShots(): number {
  let removed = 0
  for (const f of listShots()) {
    if (!isInjectShot(f.name)) continue
    try {
      unlinkSync(f.full)
      removed += 1
    } catch {
      /* ignore */
    }
  }
  return removed
}

let timer: NodeJS.Timeout | null = null
const INTERVAL_MS = 6 * 3600_000

/** 启动即清一轮 + 每 6h 一次（幂等：同一进程只挂一次） */
export function startInjectShotsHousekeeping(): void {
  if (timer) return
  timer = setInterval(() => {
    try {
      pruneInjectShots()
    } catch {
      /* 清理失败不影响主流程，下轮再试 */
    }
  }, INTERVAL_MS)
  setTimeout(() => {
    try {
      const r = pruneInjectShots()
      if (r.removed > 0) {
        shotLog.info(
          `注入截图清理：删除 ${r.removed} 张（${Math.round(r.freedBytes / 1024)} KB），保留 ${r.kept} 张`
        )
      }
    } catch {
      /* ignore */
    }
  }, 8_000)
}

export function stopInjectShotsHousekeeping(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
