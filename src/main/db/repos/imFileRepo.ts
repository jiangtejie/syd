import { getDb } from '../database'

/**
 * 渠道接收文件索引(im_file_record)仓储。
 * 负责登记/查询/删除记录;文件系统删除由上层(channelFilesService)统一负责。
 */

export interface FileRecordRow {
  id: number
  channel: string
  accountId: number
  messageId: string
  senderId?: string
  chatId?: string
  kind: string
  fileName: string
  relPath: string
  bytes: number
  createdAt: number
}

interface FileRow {
  id: number
  channel: string
  account_id: number
  message_id: string
  sender_id: string | null
  chat_id: string | null
  kind: string
  file_name: string
  rel_path: string
  bytes: number
  created_at: number
}

function toRow(r: FileRow): FileRecordRow {
  return {
    id: r.id,
    channel: r.channel,
    accountId: r.account_id,
    messageId: r.message_id,
    senderId: r.sender_id ?? undefined,
    chatId: r.chat_id ?? undefined,
    kind: r.kind,
    fileName: r.file_name,
    relPath: r.rel_path,
    bytes: r.bytes,
    createdAt: r.created_at
  }
}

export function insertFileRecord(input: Omit<FileRecordRow, 'id'>): void {
  try {
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO im_file_record
           (channel, account_id, message_id, sender_id, chat_id, kind, file_name, rel_path, bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.channel,
        input.accountId,
        input.messageId,
        input.senderId ?? null,
        input.chatId ?? null,
        input.kind,
        input.fileName,
        input.relPath,
        input.bytes,
        input.createdAt
      )
  } catch {
    /* 索引失败不影响文件本身(已落盘);下次孤儿清理可兜底 */
  }
}

export function listFileRecords(opts: {
  channel?: string
  accountId?: number
  kind?: string
  limit?: number
}): FileRecordRow[] {
  const where: string[] = []
  const args: Array<string | number> = []
  if (opts.channel) {
    where.push('channel = ?')
    args.push(opts.channel)
  }
  if (opts.accountId !== undefined) {
    where.push('account_id = ?')
    args.push(opts.accountId)
  }
  if (opts.kind) {
    where.push('kind = ?')
    args.push(opts.kind)
  }
  const sql = `SELECT * FROM im_file_record${
    where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
  } ORDER BY created_at DESC, id DESC LIMIT ?`
  const rows = getDb()
    .prepare(sql)
    .all(...args, Math.min(Math.max(Math.floor(opts.limit ?? 500), 1), 2000)) as FileRow[]
  return rows.map(toRow)
}

export function fileTotals(): { count: number; bytes: number } {
  const r = getDb()
    .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM im_file_record`)
    .get() as { n: number; b: number }
  return { count: r.n, bytes: r.b }
}

/** 取待删除记录(含相对路径),供上层删文件后一并清库 */
export function findFileRecordsByIds(ids: number[]): FileRecordRow[] {
  if (ids.length === 0) return []
  const marks = ids.map(() => '?').join(',')
  const rows = getDb()
    .prepare(`SELECT * FROM im_file_record WHERE id IN (${marks})`)
    .all(...ids) as FileRow[]
  return rows.map(toRow)
}

export function findFileRecordById(id: number): FileRecordRow | null {
  const row = getDb().prepare(`SELECT * FROM im_file_record WHERE id = ?`).get(id) as
    FileRow | undefined
  return row ? toRow(row) : null
}

export function deleteFileRecords(ids: number[]): number {
  if (ids.length === 0) return 0
  const marks = ids.map(() => '?').join(',')
  const info = getDb()
    .prepare(`DELETE FROM im_file_record WHERE id IN (${marks})`)
    .run(...ids)
  return info.changes
}

/** 全部已登记相对路径(孤儿 GC 用) */
export function allRegisteredRelPaths(): Set<string> {
  const rows = getDb().prepare(`SELECT rel_path FROM im_file_record`).all() as Array<{
    rel_path: string
  }>
  return new Set(rows.map((r) => r.rel_path))
}

/** 全量记录(升序;按账号差异化保留策略逐条判定用) */
export function allFileRecords(): FileRecordRow[] {
  const rows = getDb()
    .prepare(`SELECT * FROM im_file_record ORDER BY created_at ASC`)
    .all() as FileRow[]
  return rows.map(toRow)
}
