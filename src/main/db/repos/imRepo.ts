import { getDb } from '../database'
import type { ImChannelAccount } from '../../../shared/types'

/** im_channel_account / im_chat_map 持久化。 */

interface AccountRow {
  id: number
  channel: string
  name: string
  config: string
  enabled: number
  created_at: number
  updated_at: number
}

export interface ImAccountConfig {
  appId?: string
  appSecret?: string
  /** 绑定的微信业务账号 wxid(可选;绑定后该渠道会话具备业务查询能力) */
  wxid?: string
}

export function rowToAccount(r: AccountRow): ImChannelAccount {
  let wxid: string | undefined
  try {
    const cfg = JSON.parse(r.config) as ImAccountConfig
    wxid = (cfg.wxid ?? '').trim() || undefined
  } catch {
    /* config 损坏时仅忽略绑定信息 */
  }
  return {
    id: r.id,
    channel: r.channel === 'feishu' ? 'feishu' : 'feishu',
    name: r.name,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    wxid
  }
}

export function listImAccounts(): AccountRow[] {
  return getDb()
    .prepare(`SELECT * FROM im_channel_account ORDER BY created_at ASC`)
    .all() as AccountRow[]
}

export function getImAccount(id: number): AccountRow | undefined {
  return getDb().prepare(`SELECT * FROM im_channel_account WHERE id = ?`).get(id) as
    AccountRow | undefined
}

export function getImAccountConfig(id: number): ImAccountConfig {
  const row = getImAccount(id)
  if (!row) return {}
  try {
    return JSON.parse(row.config) as ImAccountConfig
  } catch {
    return {}
  }
}

export function saveImAccount(input: {
  id?: number
  name: string
  config: ImAccountConfig
  enabled?: boolean
}): { ok: boolean; error?: string; id?: number } {
  const name = (input.name || '').trim()
  const cfg = input.config
  if (!name) return { ok: false, error: '请填写账号名称' }
  if (!cfg.appId?.trim() || !cfg.appSecret?.trim()) {
    return { ok: false, error: '请填写飞书应用 App ID 与 App Secret' }
  }
  // 规范化:wxid 空串视为未绑定,不入库
  if (cfg.wxid) cfg.wxid = cfg.wxid.trim()
  else delete cfg.wxid
  const db = getDb()
  const now = Date.now()
  const json = JSON.stringify(cfg)
  if (input.id) {
    const info = db
      .prepare(
        `UPDATE im_channel_account SET name = ?, config = ?, enabled = ?, updated_at = ? WHERE id = ?`
      )
      .run(name, json, input.enabled ? 1 : 0, now, input.id)
    if (info.changes === 0) return { ok: false, error: '账号不存在' }
    return { ok: true, id: input.id }
  }
  const info = db
    .prepare(
      `INSERT INTO im_channel_account (channel, name, config, enabled, created_at, updated_at)
       VALUES ('feishu', ?, ?, ?, ?, ?)`
    )
    .run(name, json, input.enabled ? 1 : 0, now, now)
  return { ok: true, id: Number(info.lastInsertRowid) }
}

export function removeImAccount(id: number): boolean {
  const db = getDb()
  db.prepare(`DELETE FROM im_chat_map WHERE account_id = ?`).run(id)
  const info = db.prepare(`DELETE FROM im_channel_account WHERE id = ?`).run(id)
  return info.changes > 0
}

export function setImAccountEnabled(id: number, enabled: boolean): boolean {
  const info = getDb()
    .prepare(`UPDATE im_channel_account SET enabled = ?, updated_at = ? WHERE id = ?`)
    .run(enabled ? 1 : 0, Date.now(), id)
  return info.changes > 0
}

/** 外部聊天 → 本地会话映射 */
export function mapChatSession(
  accountId: number,
  externalChatId: string,
  sessionId: number,
  externalName: string
): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO im_chat_map (account_id, external_chat_id, session_id, external_name, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(account_id, external_chat_id) DO UPDATE SET session_id = excluded.session_id, external_name = excluded.external_name`
  ).run(accountId, externalChatId, sessionId, externalName, Date.now())
}

export function getMappedSession(
  accountId: number,
  externalChatId: string
): { session_id: number } | undefined {
  return getDb()
    .prepare(`SELECT session_id FROM im_chat_map WHERE account_id = ? AND external_chat_id = ?`)
    .get(accountId, externalChatId) as { session_id: number } | undefined
}

/** 某账号的全部映射会话 id(账号绑定业务账号时统一补齐 L1 默认挂载用) */
export function listMappedSessionIds(accountId: number): number[] {
  const rows = getDb()
    .prepare(`SELECT session_id FROM im_chat_map WHERE account_id = ?`)
    .all(accountId) as Array<{ session_id: number }>
  return rows.map((r) => r.session_id)
}
