import { getDb } from './database'
import { getConfigNumber } from './repos/config'
import { createLogger } from '../services/logging'

const dbLog = createLogger('db')

/**
 * 本地库的表清理（保留期）。
 *
 * 背景：审计/日志类表随运行时间单调增长，而它们的访问形态只有「取最近一页」：
 * - im_audit        每条入站 IM 消息/任务一行
 * - feishu_send_log 每次飞书推送一行
 * - send_log        每次发送一行
 * report_run 早有保留策略（每任务 200 条 / 30 天），这三张一直没有 —— 这里补齐，
 * 并把「按时间倒序」的索引写在 schema/base.ts（否则清理与列表都是全表扫）。
 */

/** 保留天数配置键（0 = 不清理，设置页可改） */
export const RETENTION_DAYS_KEY = 'db.retentionDays'

const DEFAULT_KEEP_DAYS = 90
const INTERVAL_MS = 6 * 3600_000

export interface PruneResult {
  keptDays: number
  imAudit: number
  feishuSendLog: number
  sendLog: number
}

/**
 * 按保留期清理审计表。
 * im_audit 里 queued/running 的行是「正在跑的任务」，无论多老都不动（跑完自然会落终态）。
 */
export function pruneAuditTables(): PruneResult {
  const keptDays = Math.max(0, Math.floor(getConfigNumber(RETENTION_DAYS_KEY, DEFAULT_KEEP_DAYS)))
  const out: PruneResult = { keptDays, imAudit: 0, feishuSendLog: 0, sendLog: 0 }
  if (keptDays === 0) return out
  const cutoff = Date.now() - keptDays * 86_400_000
  const db = getDb()
  out.imAudit = db
    .prepare(
      "DELETE FROM im_audit WHERE created_at < ? AND (status IS NULL OR status NOT IN ('queued','running'))"
    )
    .run(cutoff).changes
  out.feishuSendLog = db
    .prepare('DELETE FROM feishu_send_log WHERE created_at < ?')
    .run(cutoff).changes
  out.sendLog = db.prepare('DELETE FROM send_log WHERE created_at < ?').run(cutoff).changes
  return out
}

let timer: NodeJS.Timeout | null = null

/** 启动即清一轮 + 每 6h 一次（幂等：同一进程只挂一次） */
export function startDbHousekeeping(): void {
  if (timer) return
  timer = setInterval(() => {
    try {
      pruneAuditTables()
    } catch {
      /* 清理失败不影响主流程，下个周期再试 */
    }
  }, INTERVAL_MS)
  setTimeout(() => {
    try {
      const r = pruneAuditTables()
      if (r.imAudit + r.feishuSendLog + r.sendLog > 0) {
        dbLog.info(
          `审计表清理(保留 ${r.keptDays} 天): im_audit ${r.imAudit} / feishu ${r.feishuSendLog} / send ${r.sendLog}`
        )
      } else {
        dbLog.debug(`审计表无需清理(保留 ${r.keptDays} 天)`)
      }
    } catch {
      /* ignore */
    }
  }, 10_000)
}

export function stopDbHousekeeping(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
