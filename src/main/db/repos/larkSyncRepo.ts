import { getDb } from '../database'

/**
 * 飞书 Base 同步映射（本地行 ↔ Base record_id）。
 *
 * 为什么必须有这张表：多维表格**没有唯一键约束**，写之前无法靠字段去重。
 * 所以「谁对应哪条记录」只能自己记：先查这张表拿 record_id → 有则 update、无则 create，
 * 再用 content_hash 判断内容没变就跳过（省掉无谓的写与限流风险）。
 */

export type LarkSyncKind = 'issue' | 'reply'

export interface LarkSyncRef {
  recordId: string
  tableId: string
  contentHash: string
}

export function getSyncRef(kind: LarkSyncKind, localId: number): LarkSyncRef | null {
  const r = getDb()
    .prepare(
      'SELECT record_id, table_id, content_hash FROM lark_sync_map WHERE kind = ? AND local_id = ?'
    )
    .get(kind, localId) as { record_id: string; table_id: string; content_hash: string } | undefined
  if (!r) return null
  return { recordId: r.record_id, tableId: r.table_id, contentHash: r.content_hash }
}

export function saveSyncRef(
  kind: LarkSyncKind,
  localId: number,
  appToken: string,
  tableId: string,
  recordId: string,
  contentHash: string
): void {
  getDb()
    .prepare(
      'INSERT INTO lark_sync_map (kind, local_id, app_token, table_id, record_id, content_hash, synced_at)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?)' +
        ' ON CONFLICT(kind, local_id) DO UPDATE SET app_token = excluded.app_token,' +
        ' table_id = excluded.table_id, record_id = excluded.record_id,' +
        ' content_hash = excluded.content_hash, synced_at = excluded.synced_at'
    )
    .run(kind, localId, appToken, tableId, recordId, contentHash, Date.now())
}

export function dropSyncRef(kind: LarkSyncKind, localId: number): void {
  getDb().prepare('DELETE FROM lark_sync_map WHERE kind = ? AND local_id = ?').run(kind, localId)
}

export function countSyncRefs(kind: LarkSyncKind): number {
  const r = getDb().prepare('SELECT COUNT(*) AS c FROM lark_sync_map WHERE kind = ?').get(kind) as {
    c: number
  }
  return r.c
}
