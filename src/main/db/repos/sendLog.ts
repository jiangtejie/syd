import { getDb } from '../database'
import type { SendResultStatus } from '../../../shared/types'

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
    .prepare(
      `SELECT COUNT(*) AS n FROM send_log WHERE result = 'sent' AND created_at >= ?`
    )
    .get(dayStart.getTime()) as { n: number }
  return row.n
}

/** 近 N 天发送统计（看板用）：返回 { day: 'M/D', sent, failed } 按日期升序 */
export function countRecentDays(days: number): Array<{ day: string; sent: number; failed: number }> {
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
