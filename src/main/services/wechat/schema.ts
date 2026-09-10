import type Database from 'better-sqlite3-multiple-ciphers'

/**
 * 微信库 schema 解析（自研实现）。
 * 微信不同版本列名有差异，统一做兼容探测。
 */

export interface MessageTableColumns {
  names: Set<string>
  /** 小写列名 -> 真实列名 */
  lower: Map<string, string>
  contentColumn: string | null
  compressColumn: string | null
  senderColumn: string | null
  hasRealSenderId: boolean
  hasIsSend: boolean
  hasLocalType: boolean
  hasType: boolean
}

const CONTENT_CANDIDATES = [
  'message_content',
  'display_content',
  'content',
  'msg_content',
  'str_content',
  'strContent'
]
const COMPRESS_CANDIDATES = [
  'compress_content',
  'compressContent',
  'compressedContent',
  'CompressContent'
]
const SENDER_CANDIDATES = [
  'real_sender',
  'wxid_sender',
  'sender',
  'sender_username',
  'talker',
  'talker_id',
  'src'
]

function findColumn(lower: Map<string, string>, candidates: string[]): string | null {
  for (const candidate of candidates) {
    const actual = lower.get(candidate.toLowerCase())
    if (actual) return actual
  }
  return null
}

/** 解析消息表列信息（PRAGMA table_info） */
export function getMessageTableColumns(
  db: Database.Database,
  tableName: string
): MessageTableColumns {
  const rows = db.prepare(`PRAGMA table_info("${tableName}")`).all() as { name: string }[]
  const names = new Set(rows.map((r) => r.name))
  const lower = new Map<string, string>()
  for (const row of rows) {
    if (!lower.has(row.name.toLowerCase())) lower.set(row.name.toLowerCase(), row.name)
  }
  return {
    names,
    lower,
    contentColumn: findColumn(lower, CONTENT_CANDIDATES),
    compressColumn: findColumn(lower, COMPRESS_CANDIDATES),
    senderColumn: findColumn(lower, SENDER_CANDIDATES),
    hasRealSenderId: names.has('real_sender_id'),
    hasIsSend: names.has('is_send') || lower.has('issend'),
    hasLocalType: names.has('local_type') || lower.has('localtype'),
    hasType: names.has('type')
  }
}

/** 会话表名兼容：SessionTable / Session / session */
export function resolveSessionTableName(db: Database.Database): string | null {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
    name: string
  }[]
  const names = new Set(rows.map((r) => r.name))
  for (const name of ['SessionTable', 'Session', 'session']) {
    if (names.has(name)) return name
  }
  return null
}

/**
 * 行的小写键映射缓存（WeakMap：行对象被回收即自动释放）。
 * 慢路径原本每次调用都重建整行的 Map，而 rowToMessage 对同一行要调 ~13 次，
 * 且可空列（packed_info_data/server_id 对文本消息为 NULL）必然走慢路径。
 */
const rowLowerKeys = new WeakMap<object, Map<string, string>>()

/* eslint-disable @typescript-eslint/no-explicit-any -- 微信库表结构随版本变化,此层刻意保持动态行取值 */
/** 从行中按候选名取值（兼容大小写） */
export function getRowField(row: Record<string, any>, candidates: string[]): any {
  for (const name of candidates) {
    if (row[name] !== undefined && row[name] !== null) return row[name]
  }
  let lowerMap = rowLowerKeys.get(row)
  if (!lowerMap) {
    lowerMap = new Map<string, string>()
    for (const key of Object.keys(row)) lowerMap.set(key.toLowerCase(), key)
    rowLowerKeys.set(row, lowerMap)
  }
  for (const name of candidates) {
    const actual = lowerMap.get(name.toLowerCase())
    if (actual && row[actual] !== undefined && row[actual] !== null) return row[actual]
  }
  return undefined
}

/* eslint-enable @typescript-eslint/no-explicit-any */

/** 数值字段安全取数 */
export function toNumber(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback
  if (typeof value === 'bigint') return Number(value)
  const parsed = Number(String(value).trim())
  return Number.isFinite(parsed) ? parsed : fallback
}

/** 字符串字段安全取数（Buffer 转 utf8） */
export function toString(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (Buffer.isBuffer(value)) return value.toString('utf-8')
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf-8')
  const text = String(value).trim()
  return text
}
