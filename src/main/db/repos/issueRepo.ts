import { getDb } from '../database'
import { getConfigNumber } from './config'
import type {
  FeedbackIssue,
  FeedbackIssueDetail,
  FeedbackIssueMsg,
  FeedbackIssueSeverity,
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
  assignee: string | null
  severity: string | null
  need_confirm: number | null
  reopen_count: number | null
  reopened_from: number | null
  customers: string | null
  auto_done?: number | null
  follow_up?: number | null
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
  /** 跟进中（客服已回复未闭环）：open + followUp 展示为「跟进中」 */
  followUp?: boolean
  /** LLM 判定已解决/无需运营：true 时不新建，仅当同 key 已存在 open 时自动闭环 */
  resolved?: boolean
  /** 严重度（LLM/规则判定） */
  severity?: FeedbackIssueSeverity
  /** 疑似待人工确认（规则弱命中） */
  needConfirm?: boolean
  /** 复发标记：提取方确认命中「同群同客户同类型且上次已闭环」后回填 */
  reopenCount?: number
  reopenedFrom?: number
  /** 涉及的客户昵称（持久化，供复发识别与统计） */
  customers?: string[]
  /** 关联消息（证据） */
  msgs: FeedbackIssueMsg[]
}

/** customers JSON 安全解析 */
function parseCustomers(raw: string | null): string[] | undefined {
  if (!raw) return undefined
  try {
    const v = JSON.parse(raw) as unknown
    if (Array.isArray(v)) {
      const arr = v.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
      return arr.length > 0 ? arr : undefined
    }
  } catch {
    /* ignore */
  }
  return undefined
}

/** severity 归一（老数据/脏数据回落 一般） */
function normSeverity(v: string | null | undefined): FeedbackIssueSeverity {
  return v === '紧急' || v === '高' ? v : '一般'
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
    assignee: r.assignee ?? undefined,
    severity: normSeverity(r.severity),
    needConfirm: r.need_confirm === 1,
    reopenCount: r.reopen_count ?? 0,
    reopenedFrom: r.reopened_from ?? undefined,
    customers: parseCustomers(r.customers),
    autoDone: r.auto_done === 1,
    followUp: r.follow_up === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    msgCount: 0
  }
}

/** 跟进超时阈值:app_config monitor.followUpHours 可配(默认 12h),见 decorateFollowUpOverdue */

/** open 且 followUp 的行：按最后一条证据是否为客服消息及时间计算 overdue(阈值 app_config monitor.followUpHours,默认 12) */
function decorateFollowUpOverdue(issue: FeedbackIssue): void {
  if (!issue.followUp || issue.status !== 'open') return
  const hours = getConfigNumber('monitor.followUpHours', 12)
  const limit = Math.max(1, hours) * 3600_000
  const last = getDb()
    .prepare(
      `SELECT msg_time, is_send FROM issue_feedback_msg
       WHERE issue_id = ? ORDER BY seq DESC LIMIT 1`
    )
    .get(issue.id) as { msg_time: number; is_send: number } | undefined
  if (last && last.is_send === 1 && Date.now() - last.msg_time > limit) {
    issue.followUpOverdue = true
  }
}

/** upsert 一个问题：新建或更新内容，人工状态原样保留（follow_up 随最新分析刷新） */
export function upsertIssue(issue: NewIssue): { id: number; created: boolean } {
  const db = getDb()
  const now = Date.now()
  const followUp = issue.followUp ? 1 : 0
  const severity = issue.severity ?? '一般'
  const customers = issue.customers && issue.customers.length > 0 ? issue.customers : undefined
  db.prepare(
    `INSERT OR IGNORE INTO issue_feedback
       (key, wxid, group_username, group_name, type, title, summary, occur_at, status, method,
        follow_up, severity, need_confirm, reopen_count, reopened_from, customers, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    followUp,
    severity,
    issue.needConfirm ? 1 : 0,
    issue.reopenCount ?? 0,
    issue.reopenedFrom ?? null,
    customers ? JSON.stringify(customers) : null,
    now,
    now
  )
  const row = db.prepare(`SELECT * FROM issue_feedback WHERE key = ?`).get(issue.key) as
    IssueRow | undefined
  if (!row) return { id: 0, created: false }
  const created = row.created_at === now && row.status === 'open'
  // 内容无实质变化时保留原 updated_at(状态变更时间=处理时间口径),避免重析刷新污染「今日解决/最近处理」
  const sameContent =
    row.group_name === issue.groupName &&
    row.type === issue.type &&
    row.title === issue.title &&
    (row.summary ?? null) === (issue.summary ?? null) &&
    row.occur_at === issue.occurAt &&
    (row.follow_up === 1) === !!issue.followUp &&
    normSeverity(row.severity) === severity &&
    JSON.stringify(parseCustomers(row.customers) ?? []) === JSON.stringify(customers ?? [])
  const touchedAt = sameContent ? row.updated_at : now
  // 疑似标记：仅对 open 行按本轮提取结果刷新；人工确认(need_confirm=0)过的行重析不再打扰；
  // 已闭环/归档行不因重析复活疑似
  const nextConfirm =
    issue.needConfirm && row.status === 'open' && row.need_confirm !== 0
      ? 1
      : (row.need_confirm ?? 0)
  db.prepare(
    `UPDATE issue_feedback
       SET group_name = ?, type = ?, title = ?, summary = ?, occur_at = ?, follow_up = ?,
           severity = ?, customers = ?, need_confirm = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    issue.groupName,
    issue.type,
    issue.title,
    issue.summary ?? null,
    issue.occurAt,
    followUp,
    severity,
    customers ? JSON.stringify(customers) : null,
    nextConfirm,
    touchedAt,
    row.id
  )

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

/** 人工/自动状态流转。auto=true 表示引擎自动闭环（unreplied 检测到回复），auto_done 标记保留供 UI 区分 */
export function setIssueStatus(id: number, status: FeedbackIssueStatus, auto = false): void {
  if (auto && status === 'done') {
    getDb()
      .prepare(
        `UPDATE issue_feedback SET status = ?, updated_at = ?, auto_done = 1, follow_up = 0 WHERE id = ?`
      )
      .run(status, Date.now(), id)
  } else if (auto) {
    getDb()
      .prepare(`UPDATE issue_feedback SET status = ?, updated_at = ?, follow_up = 0 WHERE id = ?`)
      .run(status, Date.now(), id)
  } else {
    // 人工操作：清除自动闭环与跟进中标记（人工重新打开/处理即不再展示“自动解决/跟进中”）
    getDb()
      .prepare(
        `UPDATE issue_feedback SET status = ?, updated_at = ?, auto_done = 0, follow_up = 0 WHERE id = ?`
      )
      .run(status, Date.now(), id)
  }
}

/** 指派/更换/取消跟进人（团队成员 username；null/空串 = 未指派）。不动 updated_at（处理时间口径） */
export function setIssueAssignee(id: number, assignee: string | null): boolean {
  const owner = (assignee ?? '').trim() || null
  const info = getDb().prepare(`UPDATE issue_feedback SET assignee = ? WHERE id = ?`).run(owner, id)
  return info.changes > 0
}

/** 按稳定 key 查已有行（供 resolved 判定：存在 open 时自动闭环，不存在则不新建） */
export function findIssueByKey(key: string): { id: number; status: string } | undefined {
  return getDb().prepare(`SELECT id, status FROM issue_feedback WHERE key = ?`).get(key) as
    { id: number; status: string } | undefined
}

/** 某群待自动闭环的 open 问题（rule 型 unreplied，key 含 :unreplied:），返回 id + 锚时间 */
export function listOpenUnrepliedByGroup(
  wxid: string,
  groupUsername: string
): Array<{ id: number; key: string; occurAt: number }> {
  const rows = getDb()
    .prepare(
      `SELECT id, key, occur_at FROM issue_feedback
       WHERE wxid = ? AND group_username = ? AND status = 'open' AND method = 'rule'
         AND key LIKE '%:unreplied:%'`
    )
    .all(wxid, groupUsername) as Array<{ id: number; key: string; occur_at: number }>
  return rows.map((r) => ({ id: r.id, key: r.key, occurAt: r.occur_at }))
}

/** 清空某群 open(待处理/跟进中)记录与其证据——「重新分析」前重算用;已解决/搁置/归档历史保留 */
export function clearOpenIssuesByGroup(wxid: string, groupUsername: string): number {
  const db = getDb()
  db.prepare(
    `DELETE FROM issue_feedback_msg
     WHERE issue_id IN (SELECT id FROM issue_feedback
                        WHERE wxid = ? AND group_username = ? AND status = 'open')`
  ).run(wxid, groupUsername)
  const info = db
    .prepare(
      `DELETE FROM issue_feedback
       WHERE wxid = ? AND group_username = ? AND status = 'open'`
    )
    .run(wxid, groupUsername)
  return info.changes
}

/** 清空某群全部记录(含已解决/归档与证据)——「从零开始」用,不可恢复 */
export function clearIssuesByGroup(wxid: string, groupUsername: string): number {
  const db = getDb()
  db.prepare(
    `DELETE FROM issue_feedback_msg
     WHERE issue_id IN (SELECT id FROM issue_feedback
                        WHERE wxid = ? AND group_username = ?)`
  ).run(wxid, groupUsername)
  const info = db
    .prepare(`DELETE FROM issue_feedback WHERE wxid = ? AND group_username = ?`)
    .run(wxid, groupUsername)
  return info.changes
}

/** 按群聚合 open 计数（工作台会话列表徽标） */
export function countOpenByGroup(wxid: string): Record<string, number> {
  const rows = getDb()
    .prepare(
      `SELECT group_username, COUNT(*) AS n FROM issue_feedback
       WHERE wxid = ? AND status = 'open' AND need_confirm = 0 GROUP BY group_username`
    )
    .all(wxid) as Array<{ group_username: string; n: number }>
  const out: Record<string, number> = {}
  for (const r of rows) out[r.group_username] = r.n
  return out
}

/** 清空某账号的全部问题与关联消息（含人工状态，用于重新开始） */
export function clearIssues(wxid: string): void {
  const db = getDb()
  db.prepare(
    `DELETE FROM issue_feedback_msg WHERE issue_id IN (SELECT id FROM issue_feedback WHERE wxid = ?)`
  ).run(wxid)
  db.prepare(`DELETE FROM issue_feedback WHERE wxid = ?`).run(wxid)
}

/** 本群 open 议题的最早证据时间与标题摘要（增量分析的上下文保护与 LLM 稳定性提示用） */
export function openIssuesForGroup(
  wxid: string,
  groupUsername: string,
  limit = 8
): FeedbackIssue[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM issue_feedback WHERE wxid = ? AND group_username = ? AND status = 'open'
       ORDER BY occur_at ASC LIMIT ?`
    )
    .all(wxid, groupUsername, limit) as IssueRow[]
  const msgCountStmt = getDb().prepare(
    `SELECT COUNT(*) AS n FROM issue_feedback_msg WHERE issue_id = ?`
  )
  return rows.map((r) => {
    const issue = rowToIssue(r)
    issue.msgCount = (msgCountStmt.get(r.id) as { n: number }).n
    return issue
  })
}

/** open 议题证据消息时间集合（LLM 输入截断时的保底行） */
export function openIssueEvidenceTimes(wxid: string, groupUsername: string): Set<number> {
  const rows = getDb()
    .prepare(
      `SELECT m.msg_time FROM issue_feedback_msg m
       JOIN issue_feedback f ON f.id = m.issue_id
       WHERE f.wxid = ? AND f.group_username = ? AND f.status = 'open'`
    )
    .all(wxid, groupUsername) as Array<{ msg_time: number }>
  return new Set(rows.map((r) => r.msg_time))
}

export function listIssues(wxid: string, opts?: { status?: FeedbackIssueStatus }): FeedbackIssue[] {
  const rows = (
    opts?.status
      ? getDb()
          .prepare(
            `SELECT * FROM issue_feedback WHERE wxid = ? AND status = ?
             ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'stalled' THEN 1 WHEN 'done' THEN 2 ELSE 3 END,
                CASE severity WHEN '紧急' THEN 0 WHEN '高' THEN 1 ELSE 2 END, occur_at DESC`
          )
          .all(wxid, opts.status)
      : getDb()
          .prepare(
            `SELECT * FROM issue_feedback WHERE wxid = ?
             ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'stalled' THEN 1 WHEN 'done' THEN 2 ELSE 3 END,
                CASE severity WHEN '紧急' THEN 0 WHEN '高' THEN 1 ELSE 2 END, occur_at DESC`
          )
          .all(wxid)
  ) as IssueRow[]
  const msgCountStmt = getDb().prepare(
    `SELECT COUNT(*) AS n FROM issue_feedback_msg WHERE issue_id = ?`
  )
  return rows.map((r) => {
    const issue = rowToIssue(r)
    issue.msgCount = (msgCountStmt.get(r.id) as { n: number }).n
    decorateFollowUpOverdue(issue)
    return issue
  })
}

/** 按群列出问题（工作台「群问题」视图；open 优先，其次发生时间倒序） */
export function listIssuesByGroup(wxid: string, groupUsername: string): FeedbackIssue[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM issue_feedback WHERE wxid = ? AND group_username = ?
       ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'stalled' THEN 1 WHEN 'done' THEN 2 ELSE 3 END,
                occur_at DESC`
    )
    .all(wxid, groupUsername) as IssueRow[]
  const msgCountStmt = getDb().prepare(
    `SELECT COUNT(*) AS n FROM issue_feedback_msg WHERE issue_id = ?`
  )
  return rows.map((r) => {
    const issue = rowToIssue(r)
    issue.msgCount = (msgCountStmt.get(r.id) as { n: number }).n
    decorateFollowUpOverdue(issue)
    return issue
  })
}

export function getIssueDetail(id: number): FeedbackIssueDetail | null {
  const db = getDb()
  const row = db.prepare(`SELECT * FROM issue_feedback WHERE id = ?`).get(id) as
    IssueRow | undefined
  if (!row) return null
  const msgs = db
    .prepare(`SELECT * FROM issue_feedback_msg WHERE issue_id = ? ORDER BY seq ASC`)
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
  decorateFollowUpOverdue(issue)
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

/** 跨群关键词搜索客户问题（标题/摘要 LIKE；排除已归档），供建议 Agent 判断客户历史诉求 */
export function searchIssues(wxid: string, q: string, limit = 5): FeedbackIssue[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM issue_feedback
       WHERE wxid = ? AND status != 'archived'
         AND (title LIKE ? OR summary LIKE ?)
       ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'stalled' THEN 1 ELSE 2 END, occur_at DESC
       LIMIT ?`
    )
    .all(wxid, `%${q}%`, `%${q}%`, limit) as IssueRow[]
  const msgCountStmt = getDb().prepare(
    `SELECT COUNT(*) AS n FROM issue_feedback_msg WHERE issue_id = ?`
  )
  return rows.map((r) => {
    const issue = rowToIssue(r)
    issue.msgCount = (msgCountStmt.get(r.id) as { n: number }).n
    decorateFollowUpOverdue(issue)
    return issue
  })
}

/** 疑似确认：人工确认为真问题 → 清除疑似标记（重析对已确认行不再重标） */
export function confirmIssueDoubt(id: number): boolean {
  const info = getDb().prepare(`UPDATE issue_feedback SET need_confirm = 0 WHERE id = ?`).run(id)
  return info.changes > 0
}

export interface ReopenCandidate {
  id: number
  reopenCount: number
}

/**
 * 复发识别：同群同类型、客户身份有交叠、且上次议题已闭环（done/stalled）的最近一条。
 * 距上次间隔过短(≤2h,同一轮窗口内的连发)不算复发;身份交叠取两边的客户昵称集合。
 */
export function findReopenCandidate(
  wxid: string,
  groupUsername: string,
  type: string,
  customers: string[] | undefined,
  occurAt: number
): ReopenCandidate | null {
  const names = new Set((customers ?? []).map((n) => n.trim()).filter(Boolean))
  if (names.size === 0) return null
  const minGap = 2 * 3600_000
  const rows = getDb()
    .prepare(
      `SELECT id, occur_at, customers, reopen_count FROM issue_feedback
       WHERE wxid = ? AND group_username = ? AND type = ?
         AND status IN ('done', 'stalled')
         AND occur_at <= ?
       ORDER BY occur_at DESC LIMIT 12`
    )
    .all(wxid, groupUsername, type, occurAt - minGap) as Array<{
    id: number
    customers: string | null
    reopen_count: number
  }>
  for (const r of rows) {
    const prev = new Set((parseCustomers(r.customers) ?? []).map((n) => n.trim()))
    let overlap = false
    for (const n of names) {
      if (prev.has(n)) {
        overlap = true
        break
      }
    }
    if (overlap) return { id: r.id, reopenCount: r.reopen_count ?? 0 }
  }
  return null
}

/** 近期被人工「不是问题」归档的样本（供 LLM 反例提示抑制误报） */
export function recentRejectedSamples(wxid: string, groupUsername: string, limit = 3): string[] {
  const rows = getDb()
    .prepare(
      `SELECT type, title FROM issue_feedback
       WHERE wxid = ? AND group_username = ? AND status = 'archived'
         AND updated_at >= ?
       ORDER BY updated_at DESC LIMIT ?`
    )
    .all(wxid, groupUsername, Date.now() - 30 * 24 * 3600_000, limit) as Array<{
    type: string
    title: string
  }>
  return rows.map((r) => `[${r.type}] ${r.title}`)
}
