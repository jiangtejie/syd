import type { Database } from 'better-sqlite3-multiple-ciphers'
import type { CustomerStored } from '../../shared/customerProfile'

/**
 * 客户档案的 SQL 层：**db 由调用方传入**。
 *
 * 为什么单独一层：`repos/customerRepo.ts` 要经 getDb()（会拉进 electron），没法在自检脚本里跑。
 * 把 SQL 收在这里，scripts/customer-archive-selftest.mjs 就能用临时库跑真 DDL、断言真行为 ——
 * 尤其是那条最容易写坏的规矩：**会话同步绝不能覆盖用户填的来源/备注/标签**。
 */

export interface SessionCustomerRow {
  username: string
  displayName: string
  remark: string
  nickname: string
  alias: string
  isGroup: boolean
  /** 最近活跃时间（毫秒） */
  lastActiveAt: number | null
}

export interface UpsertResult {
  inserted: number
  updated: number
}

const clip = (s: string | undefined | null, n: number): string => (s ?? '').slice(0, n)

/** 从会话列表同步客户档案（幂等）：新客户补 first_seen_at，已有客户只更新微信侧字段 */
export function upsertCustomersFromSessions(
  db: Database,
  accountWxid: string,
  rows: SessionCustomerRow[],
  now = Date.now()
): UpsertResult {
  const out: UpsertResult = { inserted: 0, updated: 0 }
  const acct = (accountWxid ?? '').trim()
  if (!acct || !Array.isArray(rows) || rows.length === 0) return out
  const find = db.prepare('SELECT id FROM customer_profile WHERE account_wxid = ? AND username = ?')
  const insert = db.prepare(
    'INSERT INTO customer_profile' +
      ' (account_wxid, username, display_name, remark, nickname, alias, is_group, last_active_at, first_seen_at, created_at, updated_at)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
  // source / note 不在这条 UPDATE 里出现是**故意的**：同步每次打开客户页都会跑，
  // 它一旦能写这些列，用户刚打的标签/备注下一次刷新就没了。
  const update = db.prepare(
    'UPDATE customer_profile SET display_name = ?, remark = ?, nickname = ?, alias = ?, is_group = ?,' +
      ' last_active_at = MAX(COALESCE(last_active_at, 0), COALESCE(?, 0)), updated_at = ?' +
      ' WHERE account_wxid = ? AND username = ?'
  )
  for (const r of rows) {
    const username = (r.username ?? '').trim()
    if (!username) continue
    const existed = find.get(acct, username) as { id: number } | undefined
    if (existed) {
      update.run(
        clip(r.displayName, 200),
        clip(r.remark, 200),
        clip(r.nickname, 200),
        clip(r.alias, 100),
        r.isGroup ? 1 : 0,
        r.lastActiveAt ?? null,
        now,
        acct,
        username
      )
      out.updated += 1
    } else {
      insert.run(
        acct,
        username,
        clip(r.displayName, 200),
        clip(r.remark, 200),
        clip(r.nickname, 200),
        clip(r.alias, 100),
        r.isGroup ? 1 : 0,
        r.lastActiveAt ?? null,
        // 首次见到 = 现在（真值只有微信知道，事后无法回填，只能从今天开始记）
        now,
        now,
        now
      )
      out.inserted += 1
    }
  }
  return out
}

interface ProfileRow {
  username: string
  display_name: string
  remark: string
  nickname: string
  alias: string
  is_group: number
  source: string
  note: string
  first_seen_at: number | null
  last_active_at: number | null
}

/** 某账号的全部客户档案（含标签），按 username 索引返回便于与会话合并 */
export function listCustomerProfiles(
  db: Database,
  accountWxid: string
): Map<string, CustomerStored> {
  const out = new Map<string, CustomerStored>()
  const acct = (accountWxid ?? '').trim()
  if (!acct) return out
  const rows = db
    .prepare(
      'SELECT username, display_name, remark, nickname, alias, is_group, source, note, first_seen_at, last_active_at' +
        ' FROM customer_profile WHERE account_wxid = ? ORDER BY last_active_at DESC'
    )
    .all(acct) as unknown as ProfileRow[]
  const tagRows = db
    .prepare('SELECT username, tag, kind FROM customer_tag WHERE account_wxid = ? ORDER BY id ASC')
    .all(acct) as unknown as Array<{ username: string; tag: string; kind: string }>
  const tagsBy = new Map<string, { manual: string[]; derived: string[] }>()
  for (const t of tagRows) {
    const cur = tagsBy.get(t.username) ?? { manual: [], derived: [] }
    if (String(t.kind) === 'derived') cur.derived.push(String(t.tag))
    else cur.manual.push(String(t.tag))
    tagsBy.set(t.username, cur)
  }
  for (const r of rows) {
    const tags = tagsBy.get(r.username) ?? { manual: [], derived: [] }
    out.set(String(r.username), {
      username: String(r.username),
      displayName: String(r.display_name ?? ''),
      remark: String(r.remark ?? ''),
      nickname: String(r.nickname ?? ''),
      alias: String(r.alias ?? ''),
      isGroup: Number(r.is_group ?? 0) === 1,
      source: String(r.source ?? ''),
      note: String(r.note ?? ''),
      firstSeenAt: r.first_seen_at === null ? null : Number(r.first_seen_at),
      lastActiveAt: r.last_active_at === null ? null : Number(r.last_active_at),
      manualTags: tags.manual,
      derivedTags: tags.derived
    })
  }
  return out
}

/** 打标签（幂等：重复打同一个标签不报错） */
export function setCustomerTag(
  db: Database,
  accountWxid: string,
  username: string,
  tag: string,
  kind: 'manual' | 'derived' = 'manual',
  now = Date.now()
): void {
  const acct = (accountWxid ?? '').trim()
  const user = (username ?? '').trim()
  const value = clip((tag ?? '').trim(), 40)
  if (!acct || !user || !value) return
  db.prepare(
    'INSERT INTO customer_tag (account_wxid, username, tag, kind, created_at) VALUES (?, ?, ?, ?, ?)' +
      ' ON CONFLICT(account_wxid, username, tag) DO UPDATE SET kind = excluded.kind'
  ).run(acct, user, value, kind === 'derived' ? 'derived' : 'manual', now)
}

export function removeCustomerTag(
  db: Database,
  accountWxid: string,
  username: string,
  tag: string
): number {
  const acct = (accountWxid ?? '').trim()
  const user = (username ?? '').trim()
  const value = (tag ?? '').trim()
  if (!acct || !user || !value) return 0
  return Number(
    db
      .prepare('DELETE FROM customer_tag WHERE account_wxid = ? AND username = ? AND tag = ?')
      .run(acct, user, value).changes ?? 0
  )
}

/** 改来源/备注（用户数据；不存在则补一行，避免「先建档才能填」的别扭） */
export function updateCustomerFields(
  db: Database,
  accountWxid: string,
  username: string,
  patch: { source?: string; note?: string },
  now = Date.now()
): boolean {
  const acct = (accountWxid ?? '').trim()
  const user = (username ?? '').trim()
  if (!acct || !user) return false
  const existed = db
    .prepare('SELECT id FROM customer_profile WHERE account_wxid = ? AND username = ?')
    .get(acct, user) as { id: number } | undefined
  if (!existed) {
    db.prepare(
      'INSERT INTO customer_profile (account_wxid, username, source, note, first_seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(acct, user, clip(patch.source, 120), clip(patch.note, 1000), now, now, now)
    return true
  }
  const keys: string[] = []
  const vals: Array<string | number> = []
  if (patch.source !== undefined) {
    keys.push('source = ?')
    vals.push(clip(patch.source, 120))
  }
  if (patch.note !== undefined) {
    keys.push('note = ?')
    vals.push(clip(patch.note, 1000))
  }
  if (keys.length === 0) return false
  keys.push('updated_at = ?')
  vals.push(now)
  vals.push(acct, user)
  db.prepare(
    'UPDATE customer_profile SET ' + keys.join(', ') + ' WHERE account_wxid = ? AND username = ?'
  ).run(...vals)
  return true
}

export function countCustomerProfiles(db: Database, accountWxid: string): number {
  const acct = (accountWxid ?? '').trim()
  if (!acct) return 0
  const r = db
    .prepare('SELECT COUNT(*) AS c FROM customer_profile WHERE account_wxid = ?')
    .get(acct) as { c: number }
  return Number(r?.c ?? 0)
}
