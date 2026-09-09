/**
 * 舆情监控数据访问: 提及(mention) / 评论(comment) / 概览聚合。
 */

import { getDb } from '../database'
import { safeJson } from './_json'

export interface BuzzCommentView {
  id: number
  mentionId: number
  authorName: string
  content: string
  likes: number
  isHigh: boolean
  source: string
  publishedAt: number | null
  createdAt: number
}

export interface BuzzReasonView {
  tag: string
  weight: number
  evidence: string
}

export interface BuzzMentionView {
  id: number
  storeId: number | null
  storeName: string
  platform: string
  kind: string
  url: string
  platformItemId: string
  title: string
  contentText: string
  authorName: string
  authorId: string
  publishedAt: number | null
  interactions: { likes: number; collects: number; comments: number; shares: number }
  assets: string[]
  source: string
  status: string
  sentiment: string
  score: number
  riskLevel: string
  reasons: BuzzReasonView[]
  diagnosis: Record<string, unknown>
  diagnosedAt: number | null
  note: string
  createdAt: number
  updatedAt: number
  commentCount: number
  highCommentCount: number
}

export interface BuzzOverview {
  total: number
  positive: number
  neutral: number
  negative: number
  pending: number
  highRisk: number
  avgScore: number
  recent: Array<{
    id: number
    title: string
    sentiment: string
    score: number
    platform: string
    createdAt: number
  }>
}

const SELECT =
  'SELECT m.*, s.name AS store_name, ' +
  '(SELECT COUNT(*) FROM growth_buzz_comment c WHERE c.mention_id = m.id) AS cmt_count, ' +
  '(SELECT COUNT(*) FROM growth_buzz_comment c WHERE c.mention_id = m.id AND c.is_high = 1) AS cmt_high ' +
  'FROM growth_buzz_mention m LEFT JOIN growth_store s ON s.id = m.store_id '

function rowToView(r: Record<string, unknown>): BuzzMentionView {
  return {
    id: Number(r.id),
    storeId: r.store_id === null || r.store_id === undefined ? null : Number(r.store_id),
    storeName: String(r.store_name ?? ''),
    platform: String(r.platform ?? ''),
    kind: String(r.kind ?? ''),
    url: String(r.url ?? ''),
    platformItemId: String(r.platform_item_id ?? ''),
    title: String(r.title ?? ''),
    contentText: String(r.content_text ?? ''),
    authorName: String(r.author_name ?? ''),
    authorId: String(r.author_id ?? ''),
    publishedAt:
      r.published_at === null || r.published_at === undefined ? null : Number(r.published_at),
    interactions: safeJson(r.interactions_json, { likes: 0, collects: 0, comments: 0, shares: 0 }),
    assets: safeJson<string[]>(r.assets_json, []),
    source: String(r.source ?? 'manual'),
    status: String(r.status ?? 'new'),
    sentiment: String(r.sentiment ?? ''),
    score: Number(r.score ?? 0),
    riskLevel: String(r.risk_level ?? ''),
    reasons: safeJson<BuzzReasonView[]>(r.reasons_json, []),
    diagnosis: safeJson<Record<string, unknown>>(r.diagnosis_json, {}),
    diagnosedAt:
      r.diagnosed_at === null || r.diagnosed_at === undefined ? null : Number(r.diagnosed_at),
    note: String(r.note ?? ''),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    commentCount: Number(r.cmt_count ?? 0),
    highCommentCount: Number(r.cmt_high ?? 0)
  }
}

export function insertMention(input: {
  storeId: number | null
  platform: string
  kind: string
  url: string
  platformItemId: string
  title: string
  contentText: string
  authorName: string
  authorId: string
  publishedAt: number | null
  interactions: { likes: number; collects: number; comments: number; shares: number }
  assets: string[]
  source: string
  dedupeKey: string
}): { id: number; existed: boolean } {
  const db = getDb()
  const hit = db
    .prepare('SELECT id FROM growth_buzz_mention WHERE dedupe_key = ?')
    .get(input.dedupeKey) as { id: number } | undefined
  if (hit) return { id: hit.id, existed: true }
  const now = Date.now()
  const res = db
    .prepare(
      'INSERT INTO growth_buzz_mention (store_id, platform, kind, url, platform_item_id, title, content_text, author_name, author_id, published_at, interactions_json, assets_json, source, status, dedupe_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      input.storeId,
      input.platform,
      input.kind,
      input.url,
      input.platformItemId,
      input.title,
      input.contentText,
      input.authorName,
      input.authorId,
      input.publishedAt,
      JSON.stringify(input.interactions),
      JSON.stringify(input.assets),
      input.source,
      'new',
      input.dedupeKey,
      now,
      now
    )
  return { id: Number(res.lastInsertRowid), existed: false }
}

export function getMention(id: number): BuzzMentionView | null {
  const row = getDb()
    .prepare(SELECT + 'WHERE m.id = ?')
    .get(id) as Record<string, unknown> | undefined
  return row ? rowToView(row) : null
}

export function listMentions(filter: {
  storeId?: number | null
  platform?: string
  sentiment?: string
  status?: string
  keyword?: string
  limit?: number
  offset?: number
}): { items: BuzzMentionView[]; total: number } {
  const where: string[] = []
  const params: Array<string | number> = []
  if (filter.storeId) {
    where.push('m.store_id = ?')
    params.push(filter.storeId)
  }
  if (filter.platform) {
    where.push('m.platform = ?')
    params.push(filter.platform)
  }
  if (filter.sentiment) {
    where.push('m.sentiment = ?')
    params.push(filter.sentiment)
  }
  if (filter.status) {
    where.push('m.status = ?')
    params.push(filter.status)
  }
  if (filter.keyword) {
    where.push('(m.title LIKE ? OR m.content_text LIKE ? OR m.author_name LIKE ?)')
    const kw = '%' + filter.keyword + '%'
    params.push(kw, kw, kw)
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : ''
  const total = (
    getDb()
      .prepare('SELECT COUNT(*) AS n FROM growth_buzz_mention m ' + whereSql)
      .get(...params) as { n: number }
  ).n
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500)
  const offset = Math.max(filter.offset ?? 0, 0)
  const rows = getDb()
    .prepare(
      SELECT +
        whereSql +
        " ORDER BY CASE m.sentiment WHEN 'negative' THEN 0 WHEN '' THEN 1 ELSE 2 END, m.created_at DESC LIMIT ? OFFSET ?"
    )
    .all(...params, limit, offset) as unknown as Record<string, unknown>[]
  return { items: rows.map(rowToView), total }
}

export function updateMention(
  id: number,
  patch: Partial<{
    storeId: number | null
    status: string
    sentiment: string
    score: number
    riskLevel: string
    reasons: BuzzReasonView[]
    diagnosis: Record<string, unknown>
    note: string
  }>
): void {
  const keys: string[] = []
  const vals: Array<string | number | null> = []
  if (patch.storeId !== undefined) {
    keys.push('store_id = ?')
    vals.push(patch.storeId)
  }
  if (patch.status !== undefined) {
    keys.push('status = ?')
    vals.push(patch.status)
  }
  if (patch.sentiment !== undefined) {
    keys.push('sentiment = ?')
    vals.push(patch.sentiment)
  }
  if (patch.score !== undefined) {
    keys.push('score = ?')
    vals.push(patch.score)
  }
  if (patch.riskLevel !== undefined) {
    keys.push('risk_level = ?')
    vals.push(patch.riskLevel)
  }
  if (patch.reasons !== undefined) {
    keys.push('reasons_json = ?')
    vals.push(JSON.stringify(patch.reasons))
  }
  if (patch.diagnosis !== undefined) {
    keys.push('diagnosis_json = ?')
    vals.push(JSON.stringify(patch.diagnosis))
  }
  if (patch.note !== undefined) {
    keys.push('note = ?')
    vals.push(patch.note)
  }
  if (patch.diagnosis !== undefined) {
    keys.push('diagnosed_at = ?')
    vals.push(Date.now())
  }
  if (keys.length === 0) return
  vals.push(Date.now(), id)
  getDb()
    .prepare('UPDATE growth_buzz_mention SET ' + keys.join(', ') + ', updated_at = ? WHERE id = ?')
    .run(...vals)
}

export function removeMention(id: number): void {
  getDb().prepare('DELETE FROM growth_buzz_comment WHERE mention_id = ?').run(id)
  getDb().prepare('DELETE FROM growth_buzz_mention WHERE id = ?').run(id)
}

// ── 评论 ──

export function insertComment(input: {
  mentionId: number
  authorName: string
  content: string
  likes: number
  isHigh: boolean
  source: string
  publishedAt?: number | null
}): number {
  const res = getDb()
    .prepare(
      'INSERT INTO growth_buzz_comment (mention_id, author_name, content, likes, is_high, source, published_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      input.mentionId,
      input.authorName,
      input.content,
      input.likes,
      input.isHigh ? 1 : 0,
      input.source,
      input.publishedAt ?? null,
      Date.now()
    )
  return Number(res.lastInsertRowid)
}

export function listComments(mentionId: number): BuzzCommentView[] {
  const rows = getDb()
    .prepare(
      'SELECT * FROM growth_buzz_comment WHERE mention_id = ? ORDER BY is_high DESC, likes DESC, id ASC'
    )
    .all(mentionId) as unknown as Record<string, unknown>[]
  return rows.map((r) => ({
    id: Number(r.id),
    mentionId: Number(r.mention_id),
    authorName: String(r.author_name ?? ''),
    content: String(r.content ?? ''),
    likes: Number(r.likes ?? 0),
    isHigh: Number(r.is_high ?? 0) === 1,
    source: String(r.source ?? 'manual'),
    publishedAt:
      r.published_at === null || r.published_at === undefined ? null : Number(r.published_at),
    createdAt: Number(r.created_at)
  }))
}

export function removeComment(id: number): void {
  getDb().prepare('DELETE FROM growth_buzz_comment WHERE id = ?').run(id)
}

/** 重算高赞标记(前 20% 或赞数 >= 中位数 2 倍, 至少 1 条) */
export function refreshHighComments(mentionId: number): void {
  const db = getDb()
  const rows = db
    .prepare('SELECT id, likes FROM growth_buzz_comment WHERE mention_id = ? ORDER BY likes DESC')
    .all(mentionId) as unknown as Array<{ id: number; likes: number }>
  if (rows.length === 0) return
  const sorted = rows.map((r) => r.likes).sort((a, b) => b - a)
  const mid = sorted[Math.floor(sorted.length / 2)] ?? 0
  const threshold = Math.max(5, Math.floor(mid * 1.5))
  const keep = Math.max(1, Math.ceil(rows.length * 0.2))
  const highIds = new Set<number>()
  rows.forEach((r, i) => {
    if (i < keep || r.likes >= threshold) highIds.add(r.id)
  })
  const upd = db.prepare('UPDATE growth_buzz_comment SET is_high = ? WHERE id = ?')
  // 评论数条 = 数条事务:合并成一个事务
  db.transaction(() => {
    for (const r of rows) upd.run(highIds.has(r.id) ? 1 : 0, r.id)
  })()
}

// ── 概览 ──

export function buzzOverview(storeId?: number | null): BuzzOverview {
  const db = getDb()
  const where = storeId ? 'WHERE store_id = ?' : ''
  const params = storeId ? [storeId] : []
  const one = (sql: string): number => {
    const r = db.prepare(sql).get(...params) as { n: number }
    return r.n
  }
  const total = one('SELECT COUNT(*) AS n FROM growth_buzz_mention ' + where)
  const positive = one(
    'SELECT COUNT(*) AS n FROM growth_buzz_mention ' +
      (where ? where + " AND sentiment = 'positive'" : "WHERE sentiment = 'positive'")
  )
  const neutral = one(
    'SELECT COUNT(*) AS n FROM growth_buzz_mention ' +
      (where ? where + " AND sentiment = 'neutral'" : "WHERE sentiment = 'neutral'")
  )
  const negative = one(
    'SELECT COUNT(*) AS n FROM growth_buzz_mention ' +
      (where ? where + " AND sentiment = 'negative'" : "WHERE sentiment = 'negative'")
  )
  const pending = one(
    'SELECT COUNT(*) AS n FROM growth_buzz_mention ' +
      (where ? where + " AND status = 'new'" : "WHERE status = 'new'")
  )
  const highRisk = one(
    'SELECT COUNT(*) AS n FROM growth_buzz_mention ' +
      (where ? where + " AND risk_level = 'high'" : "WHERE risk_level = 'high'")
  )
  const avg = db
    .prepare(
      'SELECT COALESCE(AVG(score), 0) AS s FROM growth_buzz_mention ' +
        (where ? where + ' AND diagnosed_at IS NOT NULL' : 'WHERE diagnosed_at IS NOT NULL')
    )
    .get(...params) as { s: number }
  const recentRows = db
    .prepare(
      SELECT +
        (where ? where + ' AND ' : 'WHERE ') +
        'm.diagnosed_at IS NOT NULL ORDER BY m.created_at DESC LIMIT 6'
    )
    .all(...params) as unknown as Record<string, unknown>[]
  return {
    total,
    positive,
    neutral,
    negative,
    pending,
    highRisk,
    avgScore: Math.round(avg.s ?? 0),
    recent: recentRows.map((r) => ({
      id: Number(r.id),
      title: String(r.title ?? ''),
      sentiment: String(r.sentiment ?? ''),
      score: Number(r.score ?? 0),
      platform: String(r.platform ?? ''),
      createdAt: Number(r.created_at)
    }))
  }
}
