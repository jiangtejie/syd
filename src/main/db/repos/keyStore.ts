import { getDb } from '../database'
import type { KeyProfile, KeySource, KeyStatus } from '../../../shared/types'

function rowToProfile(row: any): KeyProfile {
  return {
    id: row.id,
    wxid: row.wxid,
    dbPath: row.db_path,
    keyEncrypted: row.key_encrypted,
    source: row.source as KeySource,
    status: row.status as KeyStatus,
    importedAt: row.imported_at,
    updatedAt: row.updated_at
  }
}

/** upsert：按 wxid 覆盖 */
export function upsertKey(profile: KeyProfile): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO key_store (wxid, db_path, key_encrypted, source, status, imported_at, updated_at)
     VALUES (@wxid, @dbPath, @keyEncrypted, @source, @status, @importedAt, @updatedAt)
     ON CONFLICT(wxid) DO UPDATE SET
       db_path = excluded.db_path,
       key_encrypted = excluded.key_encrypted,
       source = excluded.source,
       status = excluded.status,
       updated_at = excluded.updated_at`
  ).run({
    wxid: profile.wxid,
    dbPath: profile.dbPath,
    keyEncrypted: profile.keyEncrypted,
    source: profile.source,
    status: profile.status,
    importedAt: profile.importedAt,
    updatedAt: profile.updatedAt
  })
}

export function getKey(wxid: string): KeyProfile | null {
  const row = getDb().prepare(`SELECT * FROM key_store WHERE wxid = ?`).get(wxid)
  return row ? rowToProfile(row) : null
}

export function getKeys(): KeyProfile[] {
  const rows = getDb().prepare(`SELECT * FROM key_store ORDER BY updated_at DESC`).all() as any[]
  return rows.map(rowToProfile)
}

export function updateKeyStatus(wxid: string, status: KeyStatus): void {
  getDb()
    .prepare(`UPDATE key_store SET status = ?, updated_at = ? WHERE wxid = ?`)
    .run(status, Date.now(), wxid)
}
