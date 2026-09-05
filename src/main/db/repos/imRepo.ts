import { getDb } from '../database'
import type { ImChannelAccount, ImChannelKind } from '../../../shared/types'

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
  /** 微信 ClawBot 网关(可选,默认官方地址) */
  baseUrl?: string
  /** 微信 ClawBot bot_token(sealed 密文) */
  clawToken?: string
  /** 绑定的微信业务账号 wxid(可选;绑定后该渠道会话具备业务查询能力) */
  wxid?: string
  /** 业务查询白名单(逗号分隔用户标识;绑定账号后非空即启用) */
  allowUsers?: string
}

export function rowToAccount(r: AccountRow): ImChannelAccount {
  let wxid: string | undefined
  let allowUsers: string | undefined
  try {
    const cfg = JSON.parse(r.config) as ImAccountConfig
    wxid = (cfg.wxid ?? '').trim() || undefined
    allowUsers = (cfg.allowUsers ?? '').trim() || undefined
  } catch {
    /* config 损坏时仅忽略渠道扩展信息 */
  }
  return {
    id: r.id,
    channel: (r.channel === 'wechat_claw' ? 'wechat_claw' : 'feishu') as ImChannelKind,
    name: r.name,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    wxid,
    allowUsers
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
  channel: ImChannelKind
  name: string
  config: ImAccountConfig
  enabled?: boolean
}): { ok: boolean; error?: string; id?: number } {
  const name = (input.name || '').trim()
  const cfg = input.config
  const channel = input.channel === 'wechat_claw' ? 'wechat_claw' : 'feishu'
  if (!name) return { ok: false, error: '请填写账号名称' }
  if (channel === 'feishu') {
    if (!cfg.appId?.trim() || !cfg.appSecret?.trim()) {
      return { ok: false, error: '请填写飞书应用 App ID 与 App Secret' }
    }
  } else if (!cfg.clawToken?.trim()) {
    return { ok: false, error: '请填写 ClawBot bot_token(登录 ClawBot 后获取)' }
  }
  // 规范化:wxid 空串视为未绑定,不入库;allowUsers 空串视为未配置
  if (cfg.wxid) cfg.wxid = cfg.wxid.trim()
  else delete cfg.wxid
  if (cfg.allowUsers) cfg.allowUsers = cfg.allowUsers.trim()
  else delete cfg.allowUsers
  if (cfg.baseUrl) cfg.baseUrl = cfg.baseUrl.trim()
  else delete cfg.baseUrl
  if (!cfg.clawToken) delete cfg.clawToken
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
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(channel, name, json, input.enabled ? 1 : 0, now, now)
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
