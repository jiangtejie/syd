import { getDb } from '../database'

/**
 * 问题引擎的分析状态持久化（每账号一行 + 每账号每群一行）。
 *
 * 历史：这些状态以前以 JSON 串塞在 app_config 里（issue.wm:* / issue.groupAt:* /
 * issue.analyzed:* / issue.analyzeFail:*）—— 不可查询、无类型、无清理，清空群时用
 * setConfig(key,'') 当删除留下空行。现在落到 issue_group_state / issue_account_state：
 * 列有类型、可 SQL 巡检、清理是真正的 DELETE。
 */

/** 单群增量水位（时间 + 序号双线，防重复解读与漏读） */
export interface GroupWatermark {
  at: number
  msgTime: number
  /** 已消费最新消息的 sortSeq（防「迟到写入」：时间未前进但序号前进的新消息被跳过） */
  sortSeq?: number
}

/** 单群最近一次分析尝试（自动分析节流 + 失败信息透传给 UI） */
export interface GroupStamp {
  at: number
  method?: 'llm' | 'rule'
  count?: number
  error?: string
  coverage?: { msgs: number; truncated: boolean }
}

/** 账号最近一次全量重析结果 */
export interface AccountRunState {
  at: number
  method?: 'llm' | 'rule'
  count?: number
  groups?: number
  groupsTotal?: number
  capped?: boolean
  cancelled?: boolean
}

interface GroupRow {
  wm_at: number | null
  wm_msg_time: number | null
  wm_sort_seq: number | null
  last_at: number | null
  last_method: string | null
  last_count: number | null
  last_error: string | null
  coverage_msgs: number | null
  coverage_truncated: number
}

interface AccountRow {
  last_at: number | null
  last_method: string | null
  last_count: number | null
  last_groups: number | null
  last_groups_total: number | null
  last_capped: number
  last_cancelled: number
  fail_at: number | null
  fail_error: string | null
}

const method = (v: string | null): 'llm' | 'rule' | undefined =>
  v === 'llm' || v === 'rule' ? v : undefined

// ── 单群 —

export function getGroupWatermark(wxid: string, groupUsername: string): GroupWatermark | null {
  const row = getDb()
    .prepare(
      'SELECT wm_at, wm_msg_time, wm_sort_seq FROM issue_group_state' +
        ' WHERE account_wxid = ? AND group_username = ?'
    )
    .get(wxid, groupUsername) as Pick<GroupRow, 'wm_at' | 'wm_msg_time' | 'wm_sort_seq'> | undefined
  if (!row || row.wm_msg_time === null) return null
  return {
    at: row.wm_at ?? row.wm_msg_time,
    msgTime: row.wm_msg_time,
    sortSeq: row.wm_sort_seq ?? undefined
  }
}

/** 保存/推进水位（msgTime 单调推进；sortSeq 取已消费最新一条） */
export function saveGroupWatermark(wxid: string, groupUsername: string, wm: GroupWatermark): void {
  getDb()
    .prepare(
      'INSERT INTO issue_group_state (account_wxid, group_username, wm_at, wm_msg_time, wm_sort_seq, updated_at)' +
        ' VALUES (?, ?, ?, ?, ?, ?)' +
        ' ON CONFLICT(account_wxid, group_username) DO UPDATE SET' +
        ' wm_at = excluded.wm_at, wm_msg_time = excluded.wm_msg_time,' +
        ' wm_sort_seq = excluded.wm_sort_seq, updated_at = excluded.updated_at'
    )
    .run(wxid, groupUsername, wm.at, wm.msgTime, wm.sortSeq ?? null, Date.now())
}

export function getGroupStamp(wxid: string, groupUsername: string): GroupStamp | null {
  const row = getDb()
    .prepare(
      'SELECT last_at, last_method, last_count, last_error, coverage_msgs, coverage_truncated' +
        ' FROM issue_group_state WHERE account_wxid = ? AND group_username = ?'
    )
    .get(wxid, groupUsername) as
    | Pick<
        GroupRow,
        | 'last_at'
        | 'last_method'
        | 'last_count'
        | 'last_error'
        | 'coverage_msgs'
        | 'coverage_truncated'
      >
    | undefined
  if (!row || row.last_at === null) return null
  return {
    at: row.last_at,
    method: method(row.last_method),
    count: row.last_count ?? undefined,
    error: row.last_error || undefined,
    coverage:
      row.coverage_msgs === null
        ? undefined
        : { msgs: row.coverage_msgs, truncated: !!row.coverage_truncated }
  }
}

export function saveGroupStamp(wxid: string, groupUsername: string, stamp: GroupStamp): void {
  getDb()
    .prepare(
      'INSERT INTO issue_group_state' +
        ' (account_wxid, group_username, last_at, last_method, last_count, last_error, coverage_msgs, coverage_truncated, updated_at)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)' +
        ' ON CONFLICT(account_wxid, group_username) DO UPDATE SET' +
        ' last_at = excluded.last_at, last_method = excluded.last_method,' +
        ' last_count = excluded.last_count, last_error = excluded.last_error,' +
        ' coverage_msgs = excluded.coverage_msgs, coverage_truncated = excluded.coverage_truncated,' +
        ' updated_at = excluded.updated_at'
    )
    .run(
      wxid,
      groupUsername,
      stamp.at,
      stamp.method ?? null,
      stamp.count ?? null,
      stamp.error ?? null,
      stamp.coverage?.msgs ?? null,
      stamp.coverage?.truncated ? 1 : 0,
      Date.now()
    )
}

/** 清除某群分析状态（水位 + 节流戳）：清空/重算后调用，保证下次走全量而不是被旧水位跳过 */
export function clearGroupState(wxid: string, groupUsername: string): void {
  getDb()
    .prepare('DELETE FROM issue_group_state WHERE account_wxid = ? AND group_username = ?')
    .run(wxid, groupUsername)
}

// ── 账号 —

export function getAccountRunState(wxid: string): AccountRunState | null {
  const row = getDb()
    .prepare(
      'SELECT last_at, last_method, last_count, last_groups, last_groups_total, last_capped,' +
        ' last_cancelled FROM issue_account_state WHERE account_wxid = ?'
    )
    .get(wxid) as
    | Pick<
        AccountRow,
        | 'last_at'
        | 'last_method'
        | 'last_count'
        | 'last_groups'
        | 'last_groups_total'
        | 'last_capped'
        | 'last_cancelled'
      >
    | undefined
  if (!row || row.last_at === null) return null
  return {
    at: row.last_at,
    method: method(row.last_method),
    count: row.last_count ?? undefined,
    groups: row.last_groups ?? undefined,
    groupsTotal: row.last_groups_total ?? undefined,
    capped: !!row.last_capped,
    cancelled: !!row.last_cancelled
  }
}

export function saveAccountRunState(wxid: string, state: AccountRunState): void {
  getDb()
    .prepare(
      'INSERT INTO issue_account_state' +
        ' (account_wxid, last_at, last_method, last_count, last_groups, last_groups_total, last_capped, last_cancelled, updated_at)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)' +
        ' ON CONFLICT(account_wxid) DO UPDATE SET' +
        ' last_at = excluded.last_at, last_method = excluded.last_method,' +
        ' last_count = excluded.last_count, last_groups = excluded.last_groups,' +
        ' last_groups_total = excluded.last_groups_total, last_capped = excluded.last_capped,' +
        ' last_cancelled = excluded.last_cancelled, updated_at = excluded.updated_at'
    )
    .run(
      wxid,
      state.at,
      state.method ?? null,
      state.count ?? null,
      state.groups ?? null,
      state.groupsTotal ?? null,
      state.capped ? 1 : 0,
      state.cancelled ? 1 : 0,
      Date.now()
    )
}

/** 记录一次失败（保留最近一次全量结果，供 UI 同时展示「上次结果 + 本次错误」） */
export function saveAccountFail(wxid: string, error: string): void {
  getDb()
    .prepare(
      'INSERT INTO issue_account_state (account_wxid, fail_at, fail_error, updated_at)' +
        ' VALUES (?, ?, ?, ?)' +
        ' ON CONFLICT(account_wxid) DO UPDATE SET' +
        ' fail_at = excluded.fail_at, fail_error = excluded.fail_error, updated_at = excluded.updated_at'
    )
    .run(wxid, Date.now(), error.slice(0, 500), Date.now())
}

export function clearAccountFail(wxid: string): void {
  getDb()
    .prepare(
      'UPDATE issue_account_state SET fail_at = NULL, fail_error = NULL WHERE account_wxid = ?'
    )
    .run(wxid)
}

export function getAccountFail(wxid: string): { at?: number; error?: string } | null {
  const row = getDb()
    .prepare('SELECT fail_at, fail_error FROM issue_account_state WHERE account_wxid = ?')
    .get(wxid) as Pick<AccountRow, 'fail_at' | 'fail_error'> | undefined
  if (!row || (!row.fail_error && row.fail_at === null)) return null
  return { at: row.fail_at ?? undefined, error: row.fail_error ?? undefined }
}

/** 复位某账号的分析状态（清空数据后调用） */
export function clearAccountState(wxid: string): void {
  getDb().prepare('DELETE FROM issue_account_state WHERE account_wxid = ?').run(wxid)
}
