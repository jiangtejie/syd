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
  /** 回复内容是否带账号标识前缀(【账号名称】);缺省视为开启 */
  replyTag?: boolean
}

export function rowToAccount(r: AccountRow): ImChannelAccount {
  let replyTag: boolean | undefined
  try {
    const cfg = JSON.parse(r.config) as ImAccountConfig
    replyTag = cfg.replyTag !== false
  } catch {
    replyTag = true
  }
  return {
    id: r.id,
    channel: r.channel === 'feishu' ? 'feishu' : 'feishu',
    name: r.name,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    replyTag
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
