import Database from 'better-sqlite3-multiple-ciphers'
import { join } from 'path'
import { app } from 'electron'
import { migrate } from './schema'

let db: Database.Database | null = null

/** 本地库单例（better-sqlite3-multiple-ciphers，兼容 SQLCipher 与明文库） */
export function getDb(): Database.Database {
  if (db) return db
  const file = join(app.getPath('userData'), 'cs.db')
  db = new Database(file)
  db.pragma('journal_mode = WAL')
  migrate(db)
  return db
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}
