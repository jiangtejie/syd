import type Database from 'better-sqlite3-multiple-ciphers'
import { CORE_INDEXES, CORE_TABLES } from './schema/base'
import { AI_INDEXES, AI_TABLES } from './schema/ai'
import { CUSTOMER_INDEXES, CUSTOMER_TABLES } from './schema/customer'
import { COLUMN_MIGRATIONS } from './schema/columns'
import { DATA_MIGRATIONS, SCHEMA_VERSION } from './schema/migrations'

/**
 * 本地库 schema 入口（对应方案文档 §5 数据模型）
 * 消息本体存微信 DB，本地只存密钥、决策与审计数据。
 *
 * 三层结构（改表时先想清楚属于哪一层）：
 * 1. 幂等形状 DDL —— schema/base.ts：新装库由此建成，老库靠
 *    CREATE ... IF NOT EXISTS 补齐新增的表与索引；
 * 2. 幂等补列 —— schema/columns.ts：CREATE TABLE IF NOT EXISTS 不会给既有表加列；
 * 3. 一次性数据迁移 —— schema/migrations.ts：改形状 / 搬数据 / 清旧表，按 user_version
 *    门控只跑一次（老版本号只写不读，纯装饰，这里补上真正的门控）。
 *
 * 为什么整体包事务：以前几十条 DDL 裸跑，中途失败会留下「迁移到一半」的库，下次启动
 * 靠 IF NOT EXISTS 碰运气。现在基座 DDL 一个事务、每条数据迁移各自一个事务，失败即回滚。
 */

/** 迁移结果（供启动日志与排查使用） */
export interface MigrateResult {
  /** 本次实际执行的数据迁移（name） */
  applied: string[]
  /** 本次实际补的列（table.column） */
  columnsAdded: string[]
  /** 迁移前的 user_version */
  from: number
  /** 对齐后的 user_version（= SCHEMA_VERSION） */
  to: number
}

export function migrate(db: Database.Database): MigrateResult {
  const from = Number(db.pragma('user_version', { simple: true }) ?? 0)
  const columnsAdded: string[] = []

  // 1) 基座：表 + 索引 + 老库补列（幂等，每次启动都跑）
  db.transaction(() => {
    for (const sql of [
      ...CORE_TABLES,
      ...AI_TABLES,
      ...CUSTOMER_TABLES,
      ...CORE_INDEXES,
      ...AI_INDEXES,
      ...CUSTOMER_INDEXES
    ]) {
      db.exec(sql)
    }
    for (const c of COLUMN_MIGRATIONS) {
      if (ensureColumn(db, c.table, c.column, c.ddl)) columnsAdded.push(`${c.table}.${c.column}`)
    }
  })()

  // 2) 数据迁移：只跑 user_version 之后的（每条独立事务，失败回滚并抛给启动流程）
  const applied: string[] = []
  for (const m of [...DATA_MIGRATIONS].sort((a, b) => a.id - b.id)) {
    if (m.id <= from) continue
    db.transaction(() => m.run(db))()
    applied.push(m.name)
  }
  if (from !== SCHEMA_VERSION) db.pragma(`user_version = ${SCHEMA_VERSION}`)

  return { applied, columnsAdded, from, to: SCHEMA_VERSION }
}

/** 旧库补列（CREATE TABLE IF NOT EXISTS 不会加列）：探测后 ALTER ，返回是否真的加了 */
function ensureColumn(db: Database.Database, table: string, column: string, ddl: string): boolean {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (cols.length === 0) return false // 表不存在：交由建表 DDL 兜底
    if (cols.some((c) => c.name === column)) return false
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
    return true
  } catch {
    return false
  }
}

export function listTables(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    )
    .all() as Array<{ name: string }>
  return rows.map((r) => r.name)
}
