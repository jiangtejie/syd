import { getDb } from '../database'

/**
 * 每库派生密钥（db_key_map）。
 *
 * 与 key_store 的分工：key_store 存**账号级**密钥（KDF 之前的口令，一把开全部库），
 * 本表存**每库**密钥（KDF 之后，只开对应那一个库）。两者都能解密，
 * 导入配套工具 wechat-decrypt-cli 产出的密钥文件时后者用于兜底：
 * 口令拿不到（无管理员权限、hook 不可用）时，仍能靠整套派生密钥跑通。
 */

export interface DbKeyMapRow {
  label: string
  keyEncrypted: string
}

/** 覆盖写入一批标签→密文（同账号同标签 upsert） */
export function upsertEntries(
  wxid: string,
  entries: Array<{ label: string; keyEncrypted: string }>
): number {
  if (!wxid || !entries.length) return 0
  const db = getDb()
  const stmt = db.prepare(
    `INSERT INTO db_key_map (wxid, label, key_encrypted, updated_at)
     VALUES (@wxid, @label, @keyEncrypted, @updatedAt)
     ON CONFLICT(wxid, label) DO UPDATE SET
       key_encrypted = excluded.key_encrypted,
       updated_at = excluded.updated_at`
  )
  const now = Date.now()
  let written = 0
  const tx = db.transaction(() => {
    for (const entry of entries) {
      if (!entry.label || !entry.keyEncrypted) continue
      stmt.run({ wxid, label: entry.label, keyEncrypted: entry.keyEncrypted, updatedAt: now })
      written += 1
    }
  })
  tx()
  return written
}

export function getEntries(wxid: string): DbKeyMapRow[] {
  if (!wxid) return []
  return getDb()
    .prepare(
      'SELECT label, key_encrypted AS keyEncrypted FROM db_key_map WHERE wxid = ? ORDER BY label'
    )
    .all(wxid) as DbKeyMapRow[]
}

export function countEntries(wxid: string): number {
  if (!wxid) return 0
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM db_key_map WHERE wxid = ?').get(wxid) as
    { n?: number } | undefined
  return row?.n ?? 0
}

/** 有密钥环的所有账号（供设置页列出"只导入了派生密钥"的账号） */
export function listAccounts(): string[] {
  const rows = getDb()
    .prepare('SELECT DISTINCT wxid FROM db_key_map ORDER BY wxid')
    .all() as Array<{ wxid: string }>
  return rows.map((row) => row.wxid).filter(Boolean)
}

/** 清空某账号的密钥环（重新导入前调用，避免旧标签残留） */
export function deleteAll(wxid: string): number {
  if (!wxid) return 0
  return getDb().prepare('DELETE FROM db_key_map WHERE wxid = ?').run(wxid).changes
}
