import { getDb } from '../database'

/**
 * 群级自动回复开关 + 值班水位。
 *
 * - 开关：**未建行 = 继承全局默认**（客户群默认开）。这样批量管理只需写入差异，
 *   新群自动跟随默认，不会因为「没配置」而漏回。
 * - 水位：每群「已决策到哪条消息」，与议题提取的水位彼此独立（语义不同，别混一张表）。
 */

/** 群自动回复的运行模式：shadow=只记录不发送（校准期）；live=可发送（仍需过风险闸门） */
export type GroupReplyMode = 'shadow' | 'live'

export interface GroupAutoReply {
  groupUsername: string
  enabled: boolean
  mode: GroupReplyMode
  note: string
  updatedAt: number
}

/** 全局默认（app_config）：默认开、默认影子模式 —— 数字员工先看三天再开口 */
export const CFG_DEFAULT_ENABLED = 'agent.reply.defaultEnabled'
export const CFG_DEFAULT_MODE = 'agent.reply.defaultMode'

interface SwitchRow {
  group_username: string
  enabled: number
  mode: string
  note: string
  updated_at: number
}

function toSwitch(r: SwitchRow): GroupAutoReply {
  return {
    groupUsername: r.group_username,
    enabled: !!r.enabled,
    mode: r.mode === 'live' ? 'live' : 'shadow',
    note: r.note || '',
    updatedAt: r.updated_at
  }
}

export function listGroupSwitches(wxid: string): GroupAutoReply[] {
  const rows = getDb()
    .prepare('SELECT * FROM group_autoreply WHERE account_wxid = ? ORDER BY group_username')
    .all(wxid) as SwitchRow[]
  return rows.map(toSwitch)
}

export function getGroupSwitch(wxid: string, groupUsername: string): GroupAutoReply | null {
  const r = getDb()
    .prepare('SELECT * FROM group_autoreply WHERE account_wxid = ? AND group_username = ?')
    .get(wxid, groupUsername) as SwitchRow | undefined
  return r ? toSwitch(r) : null
}

/** 写单个群开关（部分字段：未传保持原值；不存在则按默认补齐后新建） */
export function setGroupSwitch(
  wxid: string,
  groupUsername: string,
  patch: { enabled?: boolean; mode?: GroupReplyMode; note?: string }
): GroupAutoReply {
  const db = getDb()
  const now = Date.now()
  const cur = getGroupSwitch(wxid, groupUsername)
  const enabled = patch.enabled ?? cur?.enabled ?? true
  const mode = patch.mode ?? cur?.mode ?? 'shadow'
  const note = patch.note ?? cur?.note ?? ''
  db.prepare(
    'INSERT INTO group_autoreply (account_wxid, group_username, enabled, mode, note, updated_at)' +
      ' VALUES (?, ?, ?, ?, ?, ?)' +
      ' ON CONFLICT(account_wxid, group_username) DO UPDATE SET' +
      ' enabled = excluded.enabled, mode = excluded.mode, note = excluded.note, updated_at = excluded.updated_at'
  ).run(wxid, groupUsername, enabled ? 1 : 0, mode, note, now)
  return { groupUsername, enabled, mode, note, updatedAt: now }
}

/** 批量设置（客户页多选）：一次事务写完，返回实际写入行数 */
export function setGroupSwitches(
  wxid: string,
  groups: string[],
  patch: { enabled?: boolean; mode?: GroupReplyMode }
): number {
  const list = [...new Set(groups.filter(Boolean))]
  if (list.length === 0) return 0
  const db = getDb()
  const run = db.transaction(() => {
    for (const g of list) setGroupSwitch(wxid, g, patch)
  })
  run()
  return list.length
}

/** 恢复默认（删掉差异行）：用于「跟随全局默认」 */
export function clearGroupSwitch(wxid: string, groupUsername: string): void {
  getDb()
    .prepare('DELETE FROM group_autoreply WHERE account_wxid = ? AND group_username = ?')
    .run(wxid, groupUsername)
}

// ── 值班水位 ──

export interface DutyState {
  groupUsername: string
  lastSeq?: number
  lastMsgTime?: number
  lastRunAt?: number
}

export function getDutyState(wxid: string, groupUsername: string): DutyState | null {
  const r = getDb()
    .prepare(
      'SELECT group_username, last_seq, last_msg_time, last_run_at FROM agent_duty_state' +
        ' WHERE account_wxid = ? AND group_username = ?'
    )
    .get(wxid, groupUsername) as
    | {
        group_username: string
        last_seq: number | null
        last_msg_time: number | null
        last_run_at: number | null
      }
    | undefined
  if (!r) return null
  return {
    groupUsername: r.group_username,
    lastSeq: r.last_seq ?? undefined,
    lastMsgTime: r.last_msg_time ?? undefined,
    lastRunAt: r.last_run_at ?? undefined
  }
}

export function saveDutyState(
  wxid: string,
  groupUsername: string,
  patch: { lastSeq?: number; lastMsgTime?: number }
): void {
  const now = Date.now()
  getDb()
    .prepare(
      'INSERT INTO agent_duty_state (account_wxid, group_username, last_seq, last_msg_time, last_run_at, updated_at)' +
        ' VALUES (?, ?, ?, ?, ?, ?)' +
        ' ON CONFLICT(account_wxid, group_username) DO UPDATE SET' +
        ' last_seq = COALESCE(excluded.last_seq, agent_duty_state.last_seq),' +
        ' last_msg_time = COALESCE(excluded.last_msg_time, agent_duty_state.last_msg_time),' +
        ' last_run_at = excluded.last_run_at, updated_at = excluded.updated_at'
    )
    .run(wxid, groupUsername, patch.lastSeq ?? null, patch.lastMsgTime ?? null, now, now)
}
