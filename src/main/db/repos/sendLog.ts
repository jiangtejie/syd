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

/**
 * 该会话在窗口内**成功发出**的时间戳（风控：同会话连发判定）。
 * 只认 result='sent'：失败/被拦的尝试没让对方看到内容，拿它们去挡重试只会碍事。
 */
export function recentSentTimesForSession(sessionId: string, sinceMs: number): number[] {
  const rows = getDb()
    .prepare(
      `SELECT created_at AS t FROM send_log WHERE session_id = ? AND result = 'sent' AND created_at >= ?`
    )
    .all(sessionId, sinceMs) as Array<{ t: number }>
  return rows.map((r) => r.t)
}

/** 窗口内成功发出的 (会话, 内容) 行（风控：内容重复率）；条数受日上限约束，量很小 */
export function recentSentRows(sinceMs: number): Array<{ sessionId: string; message: string }> {
  const rows = getDb()
    .prepare(
      `SELECT session_id AS sessionId, message FROM send_log WHERE result = 'sent' AND created_at >= ?`
    )
    .all(sinceMs) as Array<{ sessionId: string; message: string }>
  return rows
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

  return {
    ok: true,
    data: {
      days,
      totals,
      verifiedRate,
      failReasons
    }
  }
}
