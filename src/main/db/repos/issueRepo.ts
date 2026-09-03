import { getDb } from '../database'
import type {
  FeedbackIssue,
  FeedbackIssueDetail,
  FeedbackIssueMsg,
  FeedbackIssueStatus,
  FeedbackIssueType,
  FeedbackTypeCount
} from '../../../shared/types'

/**
 * issue_feedback 持久化（看板 · 群问题反馈）。
 * - 分析结果以「稳定 key」upsert：重复分析不产生重复行，且保留人工操作的状态；
 * - 状态字段：open / done / stalled / archived，仅由用户操作变更。
 */

interface IssueRow {
  id: number
  key: string
  wxid: string
  group_username: string
  group_name: string
  type: string
  title: string
  summary: string | null
  occur_at: number
  status: string
  method: string
  created_at: number
  updated_at: number
}

interface MsgRow {
  id: number
  issue_id: number
  msg_time: number
  sender_name: string
  is_send: number
  text: string
  image_md5: string | null
  local_type: number | null
}

export interface NewIssue {
  /** 稳定 key：调用方以消息级锚点生成（如 type|时间|localId），重复扫描复用同一行 */
  key: string
  wxid: string
  groupUsername: string
  groupName: string
  type: FeedbackIssueType
  title: string
  summary?: string
  occurAt: number
  method: 'llm' | 'rule'
  /** 关联消息（证据） */
  msgs: FeedbackIssueMsg[]
}

function rowToIssue(r: IssueRow): FeedbackIssue {
  return {
    id: r.id,
    wxid: r.wxid,
    groupUsername: r.group_username,
    groupName: r.group_name,
    type: r.type as FeedbackIssueType,
    title: r.title,
    summary: r.summary ?? undefined,
    occurAt: r.occur_at,
    status: r.status as FeedbackIssueStatus,
    method: (r.method === 'llm' ? 'llm' : 'rule') as FeedbackIssue['method'],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    msgCount: 0
  }
}

/** upsert 一个问题：新建或更新内容，人工状态原样保留 */
export function upsertIssue(issue: NewIssue): { id: number; created: boolean } {
  const db = getDb()
  const now = Date.now()
  db.prepare(
    `INSERT OR IGNORE INTO issue_feedback
       (key, wxid, group_username, group_name, type, title, summary, occur_at, status, method, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`
  ).run(
    issue.key,
    issue.wxid,
    issue.groupUsername,
    issue.groupName,
    issue.type,
    issue.title,
    issue.summary ?? null,
    issue.occurAt,
    issue.method,
    now,
    now
  )
  const row = db
    .prepare(
      `SELECT * FROM issue_feedback WHERE key = ?`
    )
    .get(issue.key) as IssueRow | undefined
  if (!row) return { id: 0, created: false }
  const created = row.created_at === now && row.status === 'open'
  db.prepare(
    `UPDATE issue_feedback
       SET group_name = ?, type = ?, title = ?, summary = ?, occur_at = ?, updated_at = ?
     WHERE id = ?`
  ).run(issue.groupName, issue.type, issue.title, issue.summary ?? null, issue.occurAt, now, row.id)

  // 重建关联消息（外键未强制启用，先删后插）
  db.prepare(`DELETE FROM issue_feedback_msg WHERE issue_id = ?`).run(row.id)
  const insMsg = db.prepare(
    `INSERT INTO issue_feedback_msg (issue_id, seq, msg_time, sender_name, is_send, text, image_md5, local_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  issue.msgs.forEach((m, i) => {
    insMsg.run(
      row.id,
      i,
      m.time,
      m.senderName,
      m.isSend ? 1 : 0,
      m.text,
      m.imageMd5 ?? null,
      m.localType ?? null
    )
  })
  return { id: row.id, created }
}

export function setIssueStatus(id: number, status: FeedbackIssueStatus): void {
  getDb()
    .prepare(`UPDATE issue_feedback SET status = ?, updated_at = ? WHERE id = ?`)
    .run(status, Date.now(), id)
}

/** 清空某账号的全部问题与关联消息（含人工状态，用于重新开始） */
export function clearIssues(wxid: string): void {
  const db = getDb()
  db.prepare(
    `DELETE FROM issue_feedback_msg WHERE issue_id IN (SELECT id FROM issue_feedback WHERE wxid = ?)`
  ).run(wxid)
  db.prepare(`DELETE FROM issue_feedback WHERE wxid = ?`).run(wxid)
}

export function listIssues(wxid: string, opts?: { status?: FeedbackIssueStatus }): FeedbackIssue[] {
  const rows = (
    opts?.status
      ? getDb()
          .prepare(
            `SELECT * FROM issue_feedback WHERE wxid = ? AND status = ?
             ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'stalled' THEN 1 WHEN 'done' THEN 2 ELSE 3 END, occur_at DESC`
          )
          .all(wxid, opts.status)
      : getDb()
          .prepare(
            `SELECT * FROM issue_feedback WHERE wxid = ?
             ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'stalled' THEN 1 WHEN 'done' THEN 2 ELSE 3 END, occur_at DESC`
          )
          .all(wxid)
  ) as IssueRow[]
  const msgCountStmt = getDb().prepare(
    `SELECT COUNT(*) AS n FROM issue_feedback_msg WHERE issue_id = ?`
  )
  return rows.map((r) => {
    const issue = rowToIssue(r)
    issue.msgCount = (msgCountStmt.get(r.id) as { n: number }).n
    return issue
  })
}

export function getIssueDetail(id: number): FeedbackIssueDetail | null {
  const db = getDb()
  const row = db.prepare(`SELECT * FROM issue_feedback WHERE id = ?`).get(id) as
    | IssueRow
    | undefined
  if (!row) return null
  const msgs = db
    .prepare(
      `SELECT * FROM issue_feedback_msg WHERE issue_id = ? ORDER BY seq ASC`
    )
    .all(id) as MsgRow[]
  const issue = rowToIssue(row) as FeedbackIssueDetail
  issue.related = msgs.map((m) => ({
    time: m.msg_time,
    senderName: m.sender_name,
    isSend: m.is_send === 1,
    text: m.text,
    imageMd5: m.image_md5 ?? undefined,
    localType: m.local_type ?? undefined
  }))
  issue.msgCount = msgs.length
  return issue
}

/** 按账号统计类型分布（含 archived？不含，聚焦处理面） */
export function typeCounts(wxid: string): FeedbackTypeCount[] {
  const rows = getDb()
    .prepare(
      `SELECT type, COUNT(*) AS n FROM issue_feedback
       WHERE wxid = ? AND status != 'archived' GROUP BY type ORDER BY n DESC`
    )
    .all(wxid) as Array<{ type: string; n: number }>
  const order: FeedbackIssueType[] = ['客诉', '售后', '物流', '价格', '咨询', '建议', '其他']
  return rows
    .map((r) => ({ type: r.type as FeedbackIssueType, count: r.n }))
    .sort((a, b) => b.count - a.count || order.indexOf(a.type) - order.indexOf(b.type))
}

export function countByStatus(wxid: string): Partial<Record<FeedbackIssueStatus, number>> {
  const rows = getDb()
    .prepare(`SELECT status, COUNT(*) AS n FROM issue_feedback WHERE wxid = ? GROUP BY status`)
    .all(wxid) as Array<{ status: string; n: number }>
  const out: Partial<Record<FeedbackIssueStatus, number>> = {}
  for (const r of rows) out[r.status as FeedbackIssueStatus] = r.n
  return out
}
