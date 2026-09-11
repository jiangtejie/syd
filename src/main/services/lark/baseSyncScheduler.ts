import { getConfigBoolean } from '../../db/repos/config'
import { pullIssuesBack, syncIssuesOut, type PullResult, type SyncOutResult } from './baseSync'
import { createLogger } from '../logging'

const syncLog = createLogger('lark')

/**
 * 议题 → 飞书 Base 的定时同步（默认关闭，设置了链接并在设置页打开开关才跑）。
 *
 * 节奏取 2 分钟：同事在手机上看的是「近实时」而不是实时，够用；
 * 一轮只推 updated_at 有变化的行，空轮几乎零成本。
 *
 * **先拉后推**：先把同事在表格里改的状态/跟进人应用回本地，再推本地的变更 ——
 * 顺序反了就会把对方刚改的值覆盖掉。
 */
const INTERVAL_MS = 2 * 60_000
/** 启动后延迟一会儿再跑第一轮：别和启动时的建库/迁移抢资源 */
const FIRST_DELAY_MS = 20_000

let timer: ReturnType<typeof setInterval> | null = null
let firstTimer: ReturnType<typeof setTimeout> | null = null
let wxid: string | null = null
let running = false

async function tick(): Promise<void> {
  if (!wxid || running) return
  if (!getConfigBoolean('lark.sync.enabled', false)) return
  running = true
  try {
    const pulled = await pullIssuesBack(wxid)
    if (pulled.applied > 0) {
      syncLog.info(`拉回同事改动 ${pulled.applied} 条（冲突保留本地 ${pulled.skippedLocalWin}）`)
    } else if (!pulled.ok && pulled.error) {
      syncLog.warn(`拉取失败: ${pulled.error}`)
    }
    const r = await syncIssuesOut(wxid)
    if (!r.ok && r.error) syncLog.warn(`议题同步失败: ${r.error}`)
    else if (r.created + r.updated > 0) {
      syncLog.info(`议题同步: 新增 ${r.created} · 更新 ${r.updated} · 跳过 ${r.skipped}`)
    }
  } catch (e) {
    syncLog.warn(`议题同步异常: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    running = false
  }
}

export function startBaseSyncScheduler(accountWxid: string): void {
  wxid = accountWxid
  if (timer) return
  firstTimer = setTimeout(() => void tick(), FIRST_DELAY_MS)
  timer = setInterval(() => void tick(), INTERVAL_MS)
}

export function stopBaseSyncScheduler(): void {
  if (firstTimer) clearTimeout(firstTimer)
  if (timer) clearInterval(timer)
  firstTimer = null
  timer = null
  wxid = null
}

/** 手动触发（设置页「立即同步」） */
export async function runBaseSyncNow(accountWxid: string, force = false): Promise<SyncOutResult> {
  return syncIssuesOut(accountWxid, { force })
}

/** 手动拉取同事改动（设置页「拉取同事改动」） */
export async function runBasePullNow(accountWxid: string): Promise<PullResult> {
  return pullIssuesBack(accountWxid)
}
