import { getDb } from '../database'
import type { SendOverview, SendResultStatus } from '../../../shared/types'

/**
 * send_log 审计（T8，方案 §4.5 审计日志）。
 * 所有发送（自动/人工）落库，支持事后抽查。
 */

export interface SendLogEntry {
  sessionId: string
  message: string
  mode: 'manual' | 'confirm' | 'auto'
  source: string
  result: SendResultStatus
  errorReason?: string
  verified: boolean
  createdAt: number
}

export function insertSendLog(entry: SendLogEntry): void {
  getDb()
    .prepare(
      `INSERT INTO send_log (session_id, message, mode, source, result, error_reason, verified, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      entry.sessionId,
      entry.message,
      entry.mode,
      entry.source,
      entry.result,
      entry.errorReason ?? null,
      entry.verified ? 1 : 0,
      entry.createdAt
    )
}

/** 当日已发送（含失败？仅统计成功）条数 */
export function countTodaySent(): number {
  const dayStart = new Date()
  dayStart.setHours(0, 0, 0, 0)
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM send_log WHERE result = 'sent' AND created_at >= ?`)
    .get(dayStart.getTime()) as { n: number }
  return row.n
}

/** 近 N 天发送统计（看板用）：返回 { day: 'M/D', sent, failed } 按日期升序 */
export function countRecentDays(
  days: number
): Array<{ day: string; sent: number; failed: number }> {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - (days - 1))
  const rows = getDb()
    .prepare(
      `SELECT date(created_at / 1000, 'unixepoch', 'localtime') AS d, result, COUNT(*) AS n
       FROM send_log WHERE created_at >= ? GROUP BY d, result`
    )
    .all(start.getTime()) as Array<{ d: string; result: string; n: number }>
  const map = new Map<string, { sent: number; failed: number }>()
  for (const r of rows) {
    const cur = map.get(r.d) ?? { sent: 0, failed: 0 }
    if (r.result === 'sent') cur.sent += r.n
    else cur.failed += r.n
    map.set(r.d, cur)
  }
  const out: Array<{ day: string; sent: number; failed: number }> = []
  for (let i = 0; i < days; i++) {
    const d = new Date(start)
    d.setDate(d.getDate() + i)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const cur = map.get(key) ?? { sent: 0, failed: 0 }
    out.push({ day: `${d.getMonth() + 1}/${d.getDate()}`, sent: cur.sent, failed: cur.failed })
  }
  return out
}

/** 发送审计聚合（看板用）：总量/校验通过率/失败原因 Top/发送对象 Top，仅统计近 N 天 */
export function sendOverview(days = 7): { ok: true; data: SendOverview } {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - (days - 1))
  const since = start.getTime()
  const db = getDb()

  // 各 result 计数
  const totalRows = db
    .prepare(`SELECT result, COUNT(*) AS n FROM send_log WHERE created_at >= ? GROUP BY result`)
    .all(since) as Array<{ result: string; n: number }>
  const totals: Record<string, number> = {}
  for (const r of totalRows) totals[r.result] = r.n

  // 闭环校验通过率（仅统计成功消息中被确认的占比）
  const sentRow = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(verified), 0) AS v
       FROM send_log WHERE created_at >= ? AND result = 'sent'`
    )
    .get(since) as { n: number; v: number }
  const verifiedRate = sentRow.n > 0 ? sentRow.v / sentRow.n : null

  // 失败原因 Top5（去空串）
  const failRows = db
    .prepare(
      `SELECT error_reason AS reason, COUNT(*) AS n FROM send_log
       WHERE created_at >= ? AND result = 'failed' AND error_reason IS NOT NULL AND error_reason <> ''
       GROUP BY error_reason ORDER BY n DESC LIMIT 5`
    )
    .all(since) as Array<{ reason: string; n: number }>
  const failReasons = failRows.map((r) => ({ reason: r.reason, count: r.n }))

  // 发送对象 Top5（成功优先、失败其次）
  const targetRows = db
    .prepare(
      `SELECT session_id AS sessionId,
              SUM(CASE WHEN result = 'sent' THEN 1 ELSE 0 END) AS sent,
              SUM(CASE WHEN result = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM send_log WHERE created_at >= ? AND session_id IS NOT NULL AND session_id <> ''
       GROUP BY session_id ORDER BY sent DESC, failed DESC LIMIT 5`
    )
    .all(since) as Array<{ sessionId: string; sent: number; failed: number }>

  return {
    ok: true,
    data: {
      days,
      totals,
      verifiedRate,
      failReasons,
      topTargets: targetRows.map((r) => ({
        sessionId: r.sessionId,
        sent: r.sent,
        failed: r.failed
      }))
    }
  }
}
