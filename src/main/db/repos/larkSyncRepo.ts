import { getDb } from '../database'

/**
 * 飞书 Base 同步映射（本地行 ↔ Base record_id）＋双向协作列的「上次已知值」。
 *
 * 为什么必须有这张表：多维表格**没有唯一键约束**，写之前无法靠字段去重，
 * 「谁对应哪条记录」只能自己记。除此之外还兼两个职责：
 * - content_hash：内容没变就跳过写（省限流额度）；
 * - remote_status / remote_assignee：**上次同步时 Base 上的值** —— 有了它才能区分
 *   「Base 现在的值」到底是同事改的，还是我们自己刚写上去的（否则会来回打架）。
 */

export type LarkSyncKind = 'issue' | 'reply' | 'evidence'

export interface LarkSyncRef {
  localId: number
  recordId: string
  tableId: string
  /** Base 那侧的稳定 ID（议题UID）：跨机器对齐用；老映射为空串 */
  remoteUid: string
  contentHash: string
  remoteStatus: string
  remoteAssignee: string
  remoteNote: string
  pushedAt?: number
  pulledAt?: number
}

interface RefRow {
  local_id: number
  record_id: string
  table_id: string
  remote_uid: string | null
  content_hash: string
  remote_status: string | null
  remote_assignee: string | null
  remote_note: string | null
  pushed_at: number | null
  pulled_at: number | null
}

function toRef(r: RefRow): LarkSyncRef {
  return {
    localId: r.local_id,
    recordId: r.record_id,
    tableId: r.table_id,
    remoteUid: r.remote_uid ?? '',
    contentHash: r.content_hash,
    remoteStatus: r.remote_status ?? '',
    remoteAssignee: r.remote_assignee ?? '',
    remoteNote: r.remote_note ?? '',
    pushedAt: r.pushed_at ?? undefined,
    pulledAt: r.pulled_at ?? undefined
  }
}

export function getSyncRef(kind: LarkSyncKind, localId: number): LarkSyncRef | null {
  const r = getDb()
    .prepare('SELECT * FROM lark_sync_map WHERE kind = ? AND local_id = ?')
    .get(kind, localId) as RefRow | undefined
  return r ? toRef(r) : null
}

/** 某类映射全量（拉取时按本地 id 反查 record） */
export function listSyncRefs(kind: LarkSyncKind): LarkSyncRef[] {
  const rows = getDb()
    .prepare('SELECT * FROM lark_sync_map WHERE kind = ? ORDER BY local_id ASC')
    .all(kind) as RefRow[]
  return rows.map(toRef)
}

export function saveSyncRef(
  kind: LarkSyncKind,
  localId: number,
  appToken: string,
  tableId: string,
  recordId: string,
  contentHash: string,
  remote?: {
    /** 省略即写空串（认领路径历史上就不写协作列，保持原样） */
    status?: string
    assignee?: string
    note?: string
    /** Base 那侧的稳定 ID（议题UID）；传空串不会清掉已有值 */
    uid?: string
    pushed?: boolean
    pulled?: boolean
  }
): void {
  const now = Date.now()
  getDb()
    .prepare(
      'INSERT INTO lark_sync_map' +
        ' (kind, local_id, app_token, table_id, record_id, remote_uid, content_hash, remote_status, remote_assignee, remote_note, pushed_at, pulled_at, synced_at)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)' +
        ' ON CONFLICT(kind, local_id) DO UPDATE SET app_token = excluded.app_token,' +
        ' table_id = excluded.table_id, record_id = excluded.record_id,' +
        " remote_uid = COALESCE(NULLIF(excluded.remote_uid, ''), lark_sync_map.remote_uid)," +
        ' content_hash = excluded.content_hash,' +
        ' remote_status = excluded.remote_status, remote_assignee = excluded.remote_assignee,' +
        ' remote_note = excluded.remote_note,' +
        ' pushed_at = COALESCE(excluded.pushed_at, lark_sync_map.pushed_at),' +
        ' pulled_at = COALESCE(excluded.pulled_at, lark_sync_map.pulled_at),' +
        ' synced_at = excluded.synced_at'
    )
    .run(
      kind,
      localId,
      appToken,
      tableId,
      recordId,
      remote?.uid ?? '',
      contentHash,
      remote?.status ?? '',
      remote?.assignee ?? '',
      remote?.note ?? '',
      remote?.pushed ? now : null,
      remote?.pulled ? now : null,
      now
    )
}

/** 只更新协作列的上次已知值（拉取应用后调用：把 Base 现值记为「已知」，避免判定成同事又改了一次） */
export function saveRemoteCollab(
  kind: LarkSyncKind,
  localId: number,
  remote: { status: string; assignee: string; note: string },
  contentHash?: string
): void {
  const now = Date.now()
  getDb()
    .prepare(
      'UPDATE lark_sync_map SET remote_status = ?, remote_assignee = ?, remote_note = ?, pulled_at = ?,' +
        ' content_hash = COALESCE(?, content_hash), synced_at = ? WHERE kind = ? AND local_id = ?'
    )
    .run(remote.status, remote.assignee, remote.note, now, contentHash ?? null, now, kind, localId)
}

/**
 * 只补一条映射的远端稳定 ID（老映射升级用）。
 * 刻意做成窄函数：用 saveSyncRef 顺带写会把协作列/内容 hash 一起重写，容易踩到别的逻辑。
 */
export function setSyncRefUid(kind: LarkSyncKind, localId: number, remoteUid: string): void {
  const uid = (remoteUid ?? '').trim()
  if (!uid) return
  getDb()
    .prepare(
      "UPDATE lark_sync_map SET remote_uid = ? WHERE kind = ? AND local_id = ? AND remote_uid = ''"
    )
    .run(uid, kind, localId)
}

export function dropSyncRef(kind: LarkSyncKind, localId: number): void {
  getDb().prepare('DELETE FROM lark_sync_map WHERE kind = ? AND local_id = ?').run(kind, localId)
}

/**
 * 清掉某一类的全部映射(换了一个多维表格时用)。
 * 旧映射记的是**另一个 Base 里的 record_id**,留着只会让后续更新落到不存在的记录上,
 * 所以换 Base 时宁可全部丢掉、重新推一遍。
 */
export function clearSyncRefs(kind: LarkSyncKind): number {
  const r = getDb().prepare('DELETE FROM lark_sync_map WHERE kind = ?').run(kind)
  return Number(r.changes ?? 0)
}

/**
 * 作废某一类的内容 hash（不删映射）：下一轮会把每条记录重写一遍。
 * 用途：表里**新加了列**时必须这样 —— 否则老记录的 hash 一致会被跳过，新列永远是空的
 * （实测：新建的单选列在当轮写入被飞书忽略，而 hash 已记录，之后一直跳过）。
 */
export function invalidateSyncHashes(kind: LarkSyncKind): number {
  const r = getDb()
    .prepare('UPDATE lark_sync_map SET content_hash = ? WHERE kind = ?')
    .run('', kind)
  return Number(r.changes ?? 0)
}

export function countSyncRefs(kind: LarkSyncKind): number {
  const r = getDb().prepare('SELECT COUNT(*) AS c FROM lark_sync_map WHERE kind = ?').get(kind) as {
    c: number
  }
  return r.c
}
