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
  // WAL 下 NORMAL 是官方推荐值：批量写显著变快，崩溃最多丢最后一个事务
  db.pragma('synchronous = NORMAL')
  // 定时任务/调度器与 IPC 并发写时避免 SQLITE_BUSY
  db.pragma('busy_timeout = 5000')
  db.pragma('cache_size = -16000') // 16MB 页缓存
  db.pragma('temp_store = MEMORY')
  db.pragma('mmap_size = 268435456') // 256MB
  migrate(db)
  return db
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}
