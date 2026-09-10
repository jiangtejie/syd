import { getDb } from '../database'

/** feishu_send_log(飞书出站消息审计)持久化。 */

export interface FeishuSendLogInput {
  targetKind: 'chat' | 'user'
  targetId: string
  targetName: string
  /** 发送内容快照(截断 ≤500 字) */
  content: string
  /** 来源:notify_issue_new / notify_issue_escalate / test / tool */
  source: string
  result: 'ok' | 'fail'
  error?: string
  messageId?: string
}

export interface FeishuSendLogRow extends Omit<FeishuSendLogInput, 'targetKind'> {
  id: number
  targetKind: string
  createdAt: number
}

export function insertFeishuSendLog(input: FeishuSendLogInput): void {
  getDb()
    .prepare(
      `INSERT INTO feishu_send_log
        (target_kind, target_id, target_name, content, source, result, error, message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.targetKind,
      input.targetId,
      input.targetName,
      (input.content ?? '').slice(0, 500),
      input.source,
      input.result,
      (input.error ?? '').slice(0, 500),
      input.messageId ?? '',
      Date.now()
    )
}

/** 今日成功发送条数(日限额用) */
export function countFeishuSentToday(): number {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM feishu_send_log WHERE result = 'ok' AND created_at >= ?`)
    .get(start.getTime()) as { n?: number } | undefined
  return row?.n ?? 0
}

export function listFeishuSendLogs(limit = 20): FeishuSendLogRow[] {
  const rows = getDb()
    .prepare(`SELECT * FROM feishu_send_log ORDER BY created_at DESC LIMIT ?`)
    .all(Math.min(Math.max(limit, 1), 200)) as Array<{
    id: number
    target_kind: string
    target_id: string
    target_name: string
    content: string
    source: string
    result: string
    error: string | null
    message_id: string | null
    created_at: number
  }>
  return rows.map((r) => ({
    id: r.id,
    targetKind: r.target_kind,
    targetId: r.target_id,
    targetName: r.target_name,
    content: r.content,
    source: r.source,
    result: r.result === 'ok' ? 'ok' : 'fail',
    error: r.error ?? undefined,
    messageId: r.message_id ?? undefined,
    createdAt: r.created_at
  }))
}
