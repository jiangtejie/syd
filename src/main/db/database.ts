import Database from 'better-sqlite3-multiple-ciphers'
import { join } from 'path'
import { app } from 'electron'
import { migrate, type MigrateResult } from './schema'

let db: Database.Database | null = null
let lastMigrate: MigrateResult | null = null

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
  // 外键级联（issue_feedback_msg / chat_message 的 ON DELETE CASCADE）显式开启：
  // better-sqlite3 目前默认开，但不写死在代码里就等着哪天换驱动/加选项时静默失效
  db.pragma('foreign_keys = ON')
  db.pragma('cache_size = -16000') // 16MB 页缓存
  db.pragma('temp_store = MEMORY')
  db.pragma('mmap_size = 268435456') // 256MB
  lastMigrate = migrate(db)
  return db
}

/** 最近一次迁移结果（启动日志用；未初始化返回 null） */
export function getLastMigrateResult(): MigrateResult | null {
  return lastMigrate
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}
