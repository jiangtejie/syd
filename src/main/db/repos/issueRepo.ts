import { getDb } from '../database'
import { getConfigNumber } from './config'
import type {
  FeedbackIssue,
  FeedbackIssueDetail,
  FeedbackIssueMethod,
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
  follow_up_at?: number | null
  resolved_at?: number | null
  archived_from?: string | null
  last_reply_by?: string | null
  created_at: number
  updated_at: number
}

interface MsgRow {
  id: number
  issue_id: number
  msg_time: number
  sender_name: string
  sender_username: string | null
  is_send: number
  is_team: number | null
  text: string
  image_md5: string | null
  local_type: number | null
}

/** 证据行 → 领域对象（两处读取共用，避免字段漏映射） */
function rowToIssueMsg(m: MsgRow): FeedbackIssueMsg {
  return {
    time: m.msg_time,
    senderName: m.sender_name,
    senderUsername: m.sender_username ?? undefined,
    isSend: m.is_send === 1,
    senderIsTeam: m.is_team === 1,
    text: m.text,
    imageMd5: m.image_md5 ?? undefined,
    localType: m.local_type ?? undefined
  }
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
    key: r.key,
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
    followUpAt: r.follow_up_at ?? undefined,
    lastReplyBy: r.last_reply_by ?? undefined,
    resolvedAt: r.resolved_at ?? undefined,
    archivedFrom: (r.archived_from as FeedbackIssue['archivedFrom']) ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    msgCount: 0
  }
}

/** 跟进超时阈值:app_config monitor.followUpHours 可配(默认 12h) */
const FOLLOW_UP_DEFAULT_HOURS = 12
/** IN (...) 分片大小(SQLite 变量上限) */
const DECORATE_CHUNK = 400

/**
 * 批量装饰问题列表：一次查证据计数 + 一次查每问题最新证据 + 只读一次配置。
 * 旧实现每行 1 次 COUNT(*) + 1~2 次 SQL(证据表当时无索引 → 每行全表扫)，问题越多越慢。
 */
function decorateIssues(issues: FeedbackIssue[]): void {
  if (issues.length === 0) return
  const db = getDb()
  const ids = issues.map((i) => i.id)
  const countMap = new Map<number, number>()
  const lastMap = new Map<number, { msg_time: number; is_send: number }>()
  // 跟进超时计时起点：优先 follow_up_at（规则判定的客服最后回复时间，精确到回复时刻）；
  // 历史行缺该字段时回落旧口径（最后一条证据是我方发出）
  const legacyFollowIds = issues
    .filter((i) => i.followUp && i.status === 'open' && !i.followUpAt)
    .map((i) => i.id)

  for (let i = 0; i < ids.length; i += DECORATE_CHUNK) {
    const batch = ids.slice(i, i + DECORATE_CHUNK)
    const ph = batch.map(() => '?').join(',')
    const rows = db
      .prepare(
        `SELECT issue_id, COUNT(*) AS n FROM issue_feedback_msg
         WHERE issue_id IN (${ph}) GROUP BY issue_id`
      )
      .all(...batch) as Array<{ issue_id: number; n: number }>
    for (const r of rows) countMap.set(r.issue_id, r.n)
  }

  for (let i = 0; i < legacyFollowIds.length; i += DECORATE_CHUNK) {
    const batch = legacyFollowIds.slice(i, i + DECORATE_CHUNK)
    const ph = batch.map(() => '?').join(',')
    const rows = db
      .prepare(
        `SELECT m.issue_id, m.msg_time, m.is_send FROM issue_feedback_msg m
         JOIN (SELECT issue_id, MAX(seq) AS mx FROM issue_feedback_msg
               WHERE issue_id IN (${ph}) GROUP BY issue_id) t
           ON t.issue_id = m.issue_id AND t.mx = m.seq`
      )
      .all(...batch) as Array<{ issue_id: number; msg_time: number; is_send: number }>
    for (const r of rows) lastMap.set(r.issue_id, r)
  }

  const hours = getConfigNumber('monitor.followUpHours', FOLLOW_UP_DEFAULT_HOURS)
  const limitMs = Math.max(1, hours) * 3600_000
  const now = Date.now()
  for (const issue of issues) {
    issue.msgCount = countMap.get(issue.id) ?? 0
    if (!issue.followUp || issue.status !== 'open') continue
    let replyAt = issue.followUpAt
    if (replyAt === undefined) {
      const last = lastMap.get(issue.id)
      if (last && last.is_send === 1) replyAt = last.msg_time
    }
    if (replyAt !== undefined && now - replyAt > limitMs) issue.followUpOverdue = true
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
  // 包在事务里:逐条自动提交在 WAL 下是数量级差距,且中途失败会留下"删了一半"的中间态
  const insMsg = db.prepare(
    `INSERT INTO issue_feedback_msg
       (issue_id, seq, msg_time, sender_name, sender_username, is_send, is_team, text, image_md5, local_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const rebuildMsgs = db.transaction((rows: NewIssue['msgs']) => {
    db.prepare(`DELETE FROM issue_feedback_msg WHERE issue_id = ?`).run(row.id)
    rows.forEach((m, i) => {
      insMsg.run(
        row.id,
        i,
        m.time,
        m.senderName,
        m.senderUsername ?? null,
        m.isSend ? 1 : 0,
        m.senderIsTeam ? 1 : 0,
        m.text,
        m.imageMd5 ?? null,
        m.localType ?? null
      )
    })
  })
  rebuildMsgs(issue.msgs)
  return { id: row.id, created }
}

/**
 * 人工/自动状态流转。auto=true 表示引擎自动处置（规则判定闭环/超期搁置），auto_done 标记保留供 UI 区分。
 * resolved_at 只在处置态写入（done/stalled），重新打开或归档时清空——趋势与「今日解决」据此计算，
 * 不再受 upsert 刷新 updated_at 的影响。
 */
export function setIssueStatus(id: number, status: FeedbackIssueStatus, auto = false): void {
  const now = Date.now()
  const resolvedAt = status === 'done' || status === 'stalled' ? now : null
  // 归档时记录「归档前的状态」：open = 人工判定不是问题（LLM 反例样本），
  // done/stalled = 历史已闭环归档（累计闭环率仍要算它）；重新打开/流转时清空
  let archivedFrom: string | null = null
  if (status === 'archived') {
    const prev = getDb().prepare(`SELECT status FROM issue_feedback WHERE id = ?`).get(id) as
      { status: string } | undefined
    archivedFrom = prev?.status ?? 'open'
  }
  if (auto && status === 'done') {
    getDb()
      .prepare(
        `UPDATE issue_feedback SET status = ?, updated_at = ?, resolved_at = ?, archived_from = ?,
           auto_done = 1, follow_up = 0, follow_up_at = NULL WHERE id = ?`
      )
      .run(status, now, resolvedAt, archivedFrom, id)
  } else if (auto) {
    getDb()
      .prepare(
        `UPDATE issue_feedback SET status = ?, updated_at = ?, resolved_at = ?, archived_from = ?,
           follow_up = 0, follow_up_at = NULL WHERE id = ?`
      )
      .run(status, now, resolvedAt, archivedFrom, id)
  } else {
    // 人工操作：清除自动闭环与跟进中标记（人工重新打开/处理即不再展示“自动解决/跟进中”）
    getDb()
      .prepare(
        `UPDATE issue_feedback SET status = ?, updated_at = ?, resolved_at = ?, archived_from = ?,
           auto_done = 0, follow_up = 0, follow_up_at = NULL WHERE id = ?`
      )
      .run(status, now, resolvedAt, archivedFrom, id)
  }
}

/**
 * 历史归档（长期运营收敛）：把 N 天前已闭环（done/stalled）的记录标为 archived。
 * - 用 archived_from 记住原状态，累计闭环率与趋势照旧统计它们（归档只是从活跃列表里挪走）；
 * - 人工判定「不是问题」的归档(archived_from=open)不受影响，仍是 LLM 反例样本。
 */
export function archiveResolvedBefore(wxid: string, days: number): number {
  const d = Math.min(Math.max(Math.floor(days), 1), 3650)
  const cutoff = Date.now() - d * 24 * 3600_000
  const info = getDb()
    .prepare(
      `UPDATE issue_feedback SET status = 'archived', archived_from = status, updated_at = ?
       WHERE wxid = ? AND status IN ('done', 'stalled')
         AND COALESCE(resolved_at, updated_at) < ?`
    )
    .run(Date.now(), wxid, cutoff)
  return info.changes
}

/**
 * 规则判定的跟进状态写回（确定性，分析器每轮调用）：
 * 客服/团队在同一回合内已回复 → 跟进中(1) 并记录回复时刻（跟进超时计时起点）；
 * 回合内无我方回复 → 回到待处理(0) 并清空计时起点。只作用于 open 行，不动 updated_at（处理时间口径）。
 */
export function setIssueFollowUp(
  id: number,
  followUp: boolean,
  replyAt?: number,
  replyBy?: string
): void {
  getDb()
    .prepare(
      `UPDATE issue_feedback SET follow_up = ?, follow_up_at = ?, last_reply_by = ?
       WHERE id = ? AND status = 'open'`
    )
    .run(
      followUp ? 1 : 0,
      followUp ? (replyAt ?? null) : null,
      followUp ? (replyBy ?? null) : null,
      id
    )
}

/** 指派/更换/取消跟进人（团队成员 username；null/空串 = 未指派）。不动 updated_at（处理时间口径） */
export function setIssueAssignee(id: number, assignee: string | null): boolean {
  const owner = (assignee ?? '').trim() || null
  const info = getDb().prepare(`UPDATE issue_feedback SET assignee = ? WHERE id = ?`).run(owner, id)
  return info.changes > 0
}

/** 按稳定 key 查已有行（供 resolved 判定：存在 open 时自动闭环，不存在则不新建） */
export function findIssueByKey(
  key: string
): { id: number; status: string; occurAt: number } | undefined {
  return getDb()
    .prepare(`SELECT id, status, occur_at FROM issue_feedback WHERE key = ?`)
    .get(key) as { id: number; status: string; occurAt: number } | undefined
}

/** 某问题现有证据消息（key 复用时用于合并证据，保住最早锚点行） */
export function getIssueMsgs(id: number): FeedbackIssueMsg[] {
  const rows = getDb()
    .prepare(`SELECT * FROM issue_feedback_msg WHERE issue_id = ? ORDER BY seq ASC`)
    .all(id) as MsgRow[]
  return rows.map(rowToIssueMsg)
}

/**
 * 批量取「客户 username 集合」（证据行里非我方、非团队客服的发送人）。
 * 昵称会随群昵称/备注变化，username 才是稳定身份——复发识别与同议题合并据此更稳。
 */
function evidenceCustomerUsernames(ids: number[]): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>()
  if (ids.length === 0) return out
  const ph = ids.map(() => '?').join(',')
  const rows = getDb()
    .prepare(
      `SELECT issue_id, sender_username FROM issue_feedback_msg
       WHERE issue_id IN (${ph}) AND is_send = 0 AND COALESCE(is_team, 0) = 0
         AND sender_username IS NOT NULL AND sender_username <> ''`
    )
    .all(...ids) as Array<{ issue_id: number; sender_username: string }>
  for (const r of rows) {
    const set = out.get(r.issue_id) ?? new Set<string>()
    set.add(r.sender_username)
    out.set(r.issue_id, set)
  }
  return out
}

/** 议题身份（客户昵称 + 客户 username）：任一命中即视为同一位客户 */
export interface IssueIdentity {
  customers?: string[]
  usernames?: string[]
}

/** 身份是否有可用信号（都没有则不做身份匹配，避免误合并） */
function hasIdentity(id: IssueIdentity): boolean {
  return (id.customers?.length ?? 0) > 0 || (id.usernames?.length ?? 0) > 0
}

/** 昵称或 username 任一交叠 */
function identityHit(
  prevCustomers: string[],
  prevUsernames: Set<string>,
  id: IssueIdentity
): boolean {
  const names = new Set((id.customers ?? []).map((n) => n.trim()).filter(Boolean))
  if (names.size > 0) {
    for (const n of prevCustomers) {
      if (names.has(n.trim())) return true
    }
  }
  for (const u of id.usernames ?? []) {
    if (prevUsernames.has(u)) return true
  }
  return false
}

export interface OpenIssueRef {
  id: number
  key: string
  occurAt: number
  method: FeedbackIssueMethod
  followUp: boolean
  followUpAt?: number
  /** 最后回复该议题的团队客服（未指派时的默认跟进人依据） */
  lastReplyBy?: string
}

/**
 * 某群全部 open 问题（不限提取方式）。
 * 引擎每轮据此做「规则跟进判定」——跟进中/待处理是消息流事实，不能只靠 LLM 是否又提取到同一议题。
 */
export function listOpenIssuesByGroup(wxid: string, groupUsername: string): OpenIssueRef[] {
  const rows = getDb()
    .prepare(
      `SELECT id, key, occur_at, method, follow_up, follow_up_at, last_reply_by FROM issue_feedback
       WHERE wxid = ? AND group_username = ? AND status = 'open' ORDER BY occur_at ASC`
    )
    .all(wxid, groupUsername) as Array<{
    id: number
    key: string
    occur_at: number
    method: string
    follow_up: number
    follow_up_at: number | null
    last_reply_by: string | null
  }>
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    occurAt: r.occur_at,
    method: r.method === 'llm' ? 'llm' : 'rule',
    followUp: r.follow_up === 1,
    followUpAt: r.follow_up_at ?? undefined,
    lastReplyBy: r.last_reply_by ?? undefined
  }))
}

export interface ManualFieldSnapshot {
  key: string
  assignee: string | null
  needConfirm: number
}

/** 重算前快照 open 行的人工字段（指派跟进人 / 疑似已确认），重算后按 key 回填 */
export function snapshotOpenManualFields(
  wxid: string,
  groupUsername: string
): ManualFieldSnapshot[] {
  const rows = getDb()
    .prepare(
      `SELECT key, assignee, need_confirm FROM issue_feedback
       WHERE wxid = ? AND group_username = ? AND status = 'open'`
    )
    .all(wxid, groupUsername) as Array<{
    key: string
    assignee: string | null
    need_confirm: number | null
  }>
  return rows.map((r) => ({
    key: r.key,
    assignee: r.assignee ?? null,
    needConfirm: r.need_confirm ?? 0
  }))
}

/**
 * 重算后回填人工字段：指派仅在仍为空时补（不复盖新一轮结果），疑似确认状态按快照还原。
 * 「重新分析」会先删除 open 行，若不回填，指派跟进人/人工确认会被无声清掉。
 */
export function restoreManualFields(rows: ManualFieldSnapshot[]): number {
  if (rows.length === 0) return 0
  const db = getDb()
  const stmt = db.prepare(
    `UPDATE issue_feedback SET assignee = COALESCE(assignee, ?), need_confirm = ?
     WHERE key = ? AND status = 'open'`
  )
  let n = 0
  const run = db.transaction(() => {
    for (const r of rows) n += stmt.run(r.assignee, r.needConfirm, r.key).changes
  })
  run()
  return n
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

/**
 * 有 open 问题的群（去重）。
 * 收尾巡检只需要「哪些群要跑」，用它替代 listIssues 全量拉取 + 装饰（后者随历史累积越来越重）。
 */
export function openGroupUsernames(wxid: string): string[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT group_username FROM issue_feedback
       WHERE wxid = ? AND status = 'open' AND group_username <> ''`
    )
    .all(wxid) as Array<{ group_username: string }>
  return rows.map((r) => r.group_username)
}

/** 是否存在「同群 ≥2 条 open」的可疑重复（自动合并的前置判断：没有就不必做聚类） */
export function hasDuplicateCandidates(wxid: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT group_username FROM issue_feedback
         WHERE wxid = ? AND status = 'open' GROUP BY group_username HAVING COUNT(*) > 1
       )`
    )
    .get(wxid) as { n: number } | undefined
  return (row?.n ?? 0) > 0
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

/**
 * 存量去重：把重复行归档为「重复」(archived_from='duplicate')。
 * 该标记不属于闭环（不计入闭环率/趋势），也不算「人工判定不是问题」（不进 LLM 反例），
 * 只是从活跃列表、盯办与徽标里挪走；需要时可人工「重新打开」。
 */
export function archiveDuplicates(ids: number[]): number {
  const list = ids.filter((id) => Number.isInteger(id))
  if (list.length === 0) return 0
  const ph = list.map(() => '?').join(',')
  return getDb()
    .prepare(
      `UPDATE issue_feedback SET status = 'archived', archived_from = 'duplicate', updated_at = ?,
         resolved_at = NULL, follow_up = 0, follow_up_at = NULL
       WHERE id IN (${ph}) AND status = 'open'`
    )
    .run(Date.now(), ...list).changes
}

/**
 * 存量去重：把「存活行」按合并结果写回（标题/摘要/类型/严重度/客户/首现/人工字段/证据一次落库）。
 * 只覆盖内容与证据，不动 status（仍是 open，闭环与跟进状态由引擎下一轮按事实重算）。
 */
export function applyIssueMerge(input: {
  id: number
  title: string
  summary?: string
  type: FeedbackIssueType
  severity: FeedbackIssueSeverity
  customers?: string[]
  occurAt: number
  needConfirm: number
  assignee: string | null
  reopenCount: number
  msgs: FeedbackIssueMsg[]
}): void {
  const db = getDb()
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE issue_feedback SET title = ?, summary = ?, type = ?, severity = ?, customers = ?,
         occur_at = ?, need_confirm = ?, assignee = ?, reopen_count = ?, updated_at = ? WHERE id = ?`
    ).run(
      input.title,
      input.summary ?? null,
      input.type,
      input.severity,
      input.customers && input.customers.length > 0 ? JSON.stringify(input.customers) : null,
      input.occurAt,
      input.needConfirm,
      input.assignee,
      input.reopenCount,
      Date.now(),
      input.id
    )
    db.prepare(`DELETE FROM issue_feedback_msg WHERE issue_id = ?`).run(input.id)
    const ins = db.prepare(
      `INSERT INTO issue_feedback_msg
         (issue_id, seq, msg_time, sender_name, sender_username, is_send, is_team, text, image_md5, local_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    input.msgs.forEach((m, i) => {
      ins.run(
        input.id,
        i,
        m.time,
        m.senderName,
        m.senderUsername ?? null,
        m.isSend ? 1 : 0,
        m.senderIsTeam ? 1 : 0,
        m.text,
        m.imageMd5 ?? null,
        m.localType ?? null
      )
    })
  })
  tx()
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
  const issues = rows.map((r) => rowToIssue(r))
  decorateIssues(issues)
  return issues
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

/**
 * 每个 open 议题的锚点行（最早证据）时间，升序去重。
 * 附录行有行数上限时优先保留这些行：LLM 只能引用「看得见」的行，
 * 锚点行一旦被挤出上下文，模型就会为同一议题另起一条(新 key) → 重复问题 + 旧行永不闭环。
 */
export function openIssueAnchorTimes(wxid: string, groupUsername: string): number[] {
  const rows = getDb()
    .prepare(
      `SELECT f.id AS id, f.occur_at AS occur_at, MIN(m.msg_time) AS first_msg
       FROM issue_feedback f
       LEFT JOIN issue_feedback_msg m ON m.issue_id = f.id
       WHERE f.wxid = ? AND f.group_username = ? AND f.status = 'open'
       GROUP BY f.id`
    )
    .all(wxid, groupUsername) as Array<{ id: number; occur_at: number; first_msg: number | null }>
  const times = new Set<number>()
  for (const r of rows) {
    const t = r.first_msg ?? r.occur_at
    if (typeof t === 'number' && Number.isFinite(t)) times.add(t)
  }
  return Array.from(times).sort((a, b) => a - b)
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
  const issues = rows.map((r) => rowToIssue(r))
  decorateIssues(issues)
  return issues
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
  const issues = rows.map((r) => rowToIssue(r))
  decorateIssues(issues)
  return issues
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
  issue.related = msgs.map(rowToIssueMsg)
  issue.msgCount = msgs.length
  // 详情页证据已全部读入:优先按规则记录的回复时刻判定跟进超时(无需再查一次库)
  if (issue.followUp && issue.status === 'open') {
    const last = msgs.length > 0 ? msgs[msgs.length - 1] : undefined
    const replyAt = issue.followUpAt ?? (last && last.is_send === 1 ? last.msg_time : undefined)
    const hours = getConfigNumber('monitor.followUpHours', FOLLOW_UP_DEFAULT_HOURS)
    if (replyAt !== undefined && Date.now() - replyAt > Math.max(1, hours) * 3600_000) {
      issue.followUpOverdue = true
    }
  }
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
  const issues = rows.map((r) => rowToIssue(r))
  decorateIssues(issues)
  return issues
}

/** 疑似确认：人工确认为真问题 → 清除疑似标记（重析对已确认行不再重标） */
export function confirmIssueDoubt(id: number): boolean {
  const info = getDb().prepare(`UPDATE issue_feedback SET need_confirm = 0 WHERE id = ?`).run(id)
  return info.changes > 0
}

export interface OpenTopicRow {
  id: number
  key: string
  type: string
  method: 'llm' | 'rule'
  title: string
  occurAt: number
  customers?: string[]
  /** 证据行里的客户 username（新数据才有；比昵称稳） */
  usernames: string[]
  /** 证据消息时间集合（同一性判据用） */
  evidenceTimes: number[]
}

/**
 * 某群 open 议题的「同一性判据事实」：一次查询拿齐标题/类型/客户/证据时间，
 * 供分析器在内存里比对（避免每个新议题都打一轮 SQL），也供存量去重聚类使用。
 */
export function openTopicIndex(wxid: string, groupUsername: string): OpenTopicRow[] {
  const rows = getDb()
    .prepare(
      `SELECT id, key, type, method, title, occur_at, customers FROM issue_feedback
       WHERE wxid = ? AND group_username = ? AND status = 'open' ORDER BY occur_at ASC`
    )
    .all(wxid, groupUsername) as Array<{
    id: number
    key: string
    type: string
    method: string
    title: string
    occur_at: number
    customers: string | null
  }>
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)
  const times = new Map<number, number[]>()
  const ph = ids.map(() => '?').join(',')
  const evRows = getDb()
    .prepare(
      `SELECT issue_id, msg_time FROM issue_feedback_msg
       WHERE issue_id IN (${ph}) ORDER BY msg_time ASC`
    )
    .all(...ids) as Array<{ issue_id: number; msg_time: number }>
  for (const e of evRows) {
    const arr = times.get(e.issue_id)
    if (arr) arr.push(e.msg_time)
    else times.set(e.issue_id, [e.msg_time])
  }
  const users = evidenceCustomerUsernames(ids)
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    type: r.type,
    method: r.method === 'llm' ? ('llm' as const) : ('rule' as const),
    title: r.title,
    occurAt: r.occur_at,
    customers: parseCustomers(r.customers),
    usernames: Array.from(users.get(r.id) ?? []),
    evidenceTimes: Array.from(new Set(times.get(r.id) ?? []))
  }))
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
  identity: IssueIdentity,
  occurAt: number
): ReopenCandidate | null {
  if (!hasIdentity(identity)) return null
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
  const userMap = evidenceCustomerUsernames(rows.map((r) => r.id))
  for (const r of rows) {
    const prev = parseCustomers(r.customers) ?? []
    if (identityHit(prev, userMap.get(r.id) ?? new Set<string>(), identity)) {
      return { id: r.id, reopenCount: r.reopen_count ?? 0 }
    }
  }
  return null
}

/** 近期被人工「不是问题」归档的样本（供 LLM 反例提示抑制误报） */
export function recentRejectedSamples(wxid: string, groupUsername: string, limit = 3): string[] {
  const rows = getDb()
    .prepare(
      `SELECT type, title FROM issue_feedback
       WHERE wxid = ? AND group_username = ? AND status = 'archived'
         AND COALESCE(archived_from, 'open') = 'open'
         AND updated_at >= ?
       ORDER BY updated_at DESC LIMIT ?`
    )
    .all(wxid, groupUsername, Date.now() - 30 * 24 * 3600_000, limit) as Array<{
    type: string
    title: string
  }>
  return rows.map((r) => `[${r.type}] ${r.title}`)
}
