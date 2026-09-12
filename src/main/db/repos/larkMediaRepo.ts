import { getDb } from '../database'

/**
 * 飞书素材与证据附件的本地映射(两张小表,见 schema/base.ts 的注释)。
 * 为什么不用 lark_sync_map:那张表的键是 (kind, local_id) 指向**一条 Base 记录**,
 * 而这里要表达的是「一张图 → 一个 file_token」和「一条证据 → 附件已写」两件不同的事。
 */

export interface MediaRef {
  md5: string
  fileToken: string
  fileName: string
  size: number
  uploadedAt: number
}

export function getMediaRef(md5: string): MediaRef | null {
  const key = (md5 ?? '').trim().toLowerCase()
  if (!key) return null
  const row = getDb()
    .prepare(
      'SELECT md5, file_token, file_name, size, uploaded_at FROM lark_media_map WHERE md5 = ?'
    )
    .get(key) as
    | {
        md5: string
        file_token: string
        file_name: string | null
        size: number | null
        uploaded_at: number
      }
    | undefined
  if (!row) return null
  return {
    md5: row.md5,
    fileToken: row.file_token,
    fileName: row.file_name ?? '',
    size: Number(row.size ?? 0),
    uploadedAt: Number(row.uploaded_at ?? 0)
  }
}

export function saveMediaRef(ref: {
  md5: string
  fileToken: string
  fileName?: string
  size?: number
}): void {
  getDb()
    .prepare(
      `INSERT INTO lark_media_map (md5, file_token, file_name, size, uploaded_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(md5) DO UPDATE SET
         file_token = excluded.file_token,
         file_name = excluded.file_name,
         size = excluded.size,
         uploaded_at = excluded.uploaded_at`
    )
    .run(
      ref.md5.trim().toLowerCase(),
      ref.fileToken,
      ref.fileName ?? '',
      Math.max(0, Math.round(ref.size ?? 0)),
      Date.now()
    )
}

export function countMediaRefs(): number {
  const r = getDb().prepare('SELECT COUNT(*) AS c FROM lark_media_map').get() as { c: number }
  return Number(r?.c ?? 0)
}

export function clearMediaRefs(): number {
  const r = getDb().prepare('DELETE FROM lark_media_map').run()
  return Number(r.changes ?? 0)
}

/** 该证据行的附件是否已经写过(Base 记录上的附件列) */
export function hasAttached(msgId: number): boolean {
  const row = getDb()
    .prepare('SELECT 1 AS ok FROM lark_evidence_attach WHERE msg_id = ?')
    .get(msgId) as { ok: number } | undefined
  return !!row
}

export function markAttached(msgId: number, md5: string, fileToken: string): void {
  getDb()
    .prepare(
      `INSERT INTO lark_evidence_attach (msg_id, md5, file_token, attached_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(msg_id) DO UPDATE SET
         md5 = excluded.md5, file_token = excluded.file_token, attached_at = excluded.attached_at`
    )
    .run(msgId, md5, fileToken, Date.now())
}

export function countAttached(): number {
  const r = getDb().prepare('SELECT COUNT(*) AS c FROM lark_evidence_attach').get() as {
    c: number
  }
  return Number(r?.c ?? 0)
}

export function clearAttached(): number {
  const r = getDb().prepare('DELETE FROM lark_evidence_attach').run()
  return Number(r.changes ?? 0)
}
