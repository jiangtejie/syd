import { getDb } from '../database'
import { safeJson } from './_json'
import type {
  GrowthAsset,
  GrowthContentDetail,
  GrowthContentFilter,
  GrowthContentItem,
  GrowthContentKind,
  GrowthContentStatus,
  GrowthContentUsage,
  GrowthInteractions,
  GrowthListResult
} from '../../../shared/growth'

/** growth_* 表访问层：素材 / 资产 / 拆解卡。任务与订阅见 growthOpsRepo。 */

function toNum(v: unknown, fb = 0): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fb
}

interface ContentRow {
  id: number
  kind: string
  origin: string
  platform_item_id: string
  store_id: number | null
  title: string
  content_text: string
  author_name: string
  author_id: string
  link: string
  published_at: number | null
  tags_json: string
  usage: string
  interactions_json: string
  extra_json: string | null
  score: number
  status: string
  note: string
  created_at: number
  updated_at: number
}

function rowToItem(r: ContentRow): GrowthContentItem {
  return {
    id: r.id,
    kind: (['image_text', 'video'].includes(r.kind) ? r.kind : 'unknown') as GrowthContentKind,
    origin: r.origin,
    platformItemId: r.platform_item_id,
    storeId: r.store_id,
    title: r.title,
    text: r.content_text,
    authorName: r.author_name,
    authorId: r.author_id,
    link: r.link,
    publishedAt: r.published_at ?? null,
    tags: safeJson<string[]>(r.tags_json, []),
    usage: (['ref', 'own', 'licensed'].includes(r.usage)
      ? (r.usage as GrowthContentUsage)
      : 'ref') as GrowthContentUsage,
    interactions: safeJson<GrowthInteractions>(r.interactions_json, {
      likes: 0,
      collects: 0,
      comments: 0,
      shares: 0
    }),
    extra: safeJson<Record<string, unknown>>(r.extra_json, {}),
    score: toNum(r.score),
    status: (['new', 'ready', 'used', 'archived'].includes(r.status)
      ? (r.status as GrowthContentStatus)
      : 'new') as GrowthContentStatus,
    note: r.note,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

interface AssetRow {
  id: number
  content_id: number
  kind: string
  sha256: string
  mime: string
  size: number
  width: number
  height: number
  duration_ms: number
  rel_path: string
  thumb_rel_path: string
  source_mark: string
  created_at: number
}

function rowToAsset(r: AssetRow): GrowthAsset {
  const kind = ['cover', 'image', 'video', 'audio', 'other'].includes(r.kind) ? r.kind : 'other'
  return {
    id: r.id,
    contentId: r.content_id,
    kind: kind as GrowthAsset['kind'],
    sha256: r.sha256,
    mime: r.mime,
    size: r.size,
    width: r.width,
    height: r.height,
    durationMs: r.duration_ms,
    relPath: r.rel_path,
    thumbRelPath: r.thumb_rel_path,
    sourceMark: r.source_mark,
    createdAt: r.created_at
  }
}

/** 素材插入(带 dedupe_key 去重, 返回最终 id 与是否新建) */
export function insertContent(input: {
  dedupeKey: string
  origin: string
  kind: GrowthContentKind
  platformItemId?: string
  storeId?: number | null
  title?: string
  text?: string
  authorName?: string
  authorId?: string
  link?: string
  publishedAt?: number | null
  tags?: string[]
  usage?: GrowthContentUsage
  interactions?: GrowthInteractions
  note?: string
  /** 解析附加信息(remoteMedia 等), 原样序列化入库 */
  extra?: Record<string, unknown>
}): { id: number; existed: boolean } {
  const now = Date.now()
  const interactions = input.interactions ?? { likes: 0, collects: 0, comments: 0, shares: 0 }
  const existed = getDb()
    .prepare('SELECT id FROM growth_content WHERE dedupe_key = ?')
    .get(input.dedupeKey) as { id: number } | undefined
  if (existed) return { id: existed.id, existed: true }
  const res = getDb()
    .prepare(
      `INSERT INTO growth_content (
        dedupe_key, origin, kind, platform_item_id, store_id, title, content_text,
        author_name, author_id, link, published_at, tags_json, usage, interactions_json,
        extra_json, score, status, note, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.dedupeKey,
      input.origin,
      input.kind,
      input.platformItemId ?? '',
      input.storeId ?? null,
      input.title ?? '',
      input.text ?? '',
      input.authorName ?? '',
      input.authorId ?? '',
      input.link ?? '',
      input.publishedAt ?? null,
      JSON.stringify(input.tags ?? []),
      input.usage ?? 'ref',
      JSON.stringify(interactions),
      JSON.stringify(input.extra ?? {}),
      interactionScoreOf(interactions),
      'new',
      input.note ?? '',
      now,
      now
    )
  return { id: Number(res.lastInsertRowid), existed: false }
}

/** 互动 → 启发式爆款分(权重 Phase 1 支持配置) */
export function interactionScoreOf(i: GrowthInteractions): number {
  return Math.round(i.likes + i.collects * 2 + i.comments * 2 + i.shares * 3)
}

export function listContents(filter: GrowthContentFilter): GrowthListResult {
  const where: string[] = []
  const params: Array<string | number> = []
  if (filter.keyword) {
    where.push('(title LIKE ? OR content_text LIKE ? OR author_name LIKE ?)')
    const kw = `%${filter.keyword}%`
    params.push(kw, kw, kw)
  }
  if (filter.origin) {
    where.push('origin = ?')
    params.push(filter.origin)
  }
  if (filter.usage) {
    where.push('usage = ?')
    params.push(filter.usage)
  }
  if (filter.status) {
    where.push('status = ?')
    params.push(filter.status)
  }
  if (filter.noDecomp) {
    where.push('NOT EXISTS (SELECT 1 FROM growth_decomp d WHERE d.content_id = growth_content.id)')
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const totalRow = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM growth_content ${whereSql}`)
    .get(...params) as { n: number }
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500)
  const offset = Math.max(filter.offset ?? 0, 0)
  const orderSql =
    filter.sort === 'score'
      ? 'ORDER BY score DESC, id DESC'
      : filter.sort === 'likes'
        ? "ORDER BY json_extract(interactions_json, '$.likes') DESC, id DESC"
        : 'ORDER BY created_at DESC, id DESC'
  const rows = getDb()
    .prepare(
      `
      SELECT * FROM growth_content
      ${whereSql}
      ${orderSql}
      LIMIT ? OFFSET ?
    `
    )
    .all(...params, limit, offset) as unknown as ContentRow[]
  return { items: rows.map(rowToItem), total: totalRow.n }
}

export function getContentItem(id: number): GrowthContentItem | null {
  const row = getDb().prepare('SELECT * FROM growth_content WHERE id = ?').get(id) as
    ContentRow | undefined
  return row ? rowToItem(row) : null
}

export function getContentDetail(id: number): GrowthContentDetail | null {
  const item = getContentItem(id)
  if (!item) return null
  const assetRows = getDb()
    .prepare('SELECT * FROM growth_asset WHERE content_id = ? ORDER BY id')
    .all(id) as unknown as AssetRow[]
  const decompRow = getDb().prepare('SELECT * FROM growth_decomp WHERE content_id = ?').get(id) as
    | {
        content_id: number
        model_ver: string
        structure_json: string
        visual_json: string
        comment_topics_json: string
        created_at: number
      }
    | undefined
  return {
    ...item,
    assets: assetRows.map(rowToAsset),
    decomp: decompRow
      ? {
          contentId: decompRow.content_id,
          modelVer: decompRow.model_ver,
          structure: safeJson<Record<string, unknown> | null>(decompRow.structure_json, null),
          visual: safeJson<Record<string, unknown> | null>(decompRow.visual_json, null),
          commentTopics: safeJson<string[]>(decompRow.comment_topics_json, []),
          createdAt: decompRow.created_at
        }
      : null
  }
}

/** 白名单字段更新(usage/status/note/score 等运营动作) */
export function updateContentFields(
  id: number,
  patch: Partial<Pick<GrowthContentItem, 'usage' | 'status' | 'note' | 'score'>>
): boolean {
  const keys: string[] = []
  const values: Array<string | number> = []
  if (patch.usage !== undefined) {
    keys.push('usage = ?')
    values.push(patch.usage)
  }
  if (patch.status !== undefined) {
    keys.push('status = ?')
    values.push(patch.status)
  }
  if (patch.note !== undefined) {
    keys.push('note = ?')
    values.push(patch.note)
  }
  if (patch.score !== undefined) {
    keys.push('score = ?')
    values.push(patch.score)
  }
  if (!keys.length) return false
  values.push(id)
  const res = getDb()
    .prepare(`UPDATE growth_content SET ${keys.join(', ')}, updated_at = ? WHERE id = ?`)
    .run(Date.now(), ...values)
  return res.changes > 0
}

export function deleteContent(id: number): void {
  getDb().prepare('DELETE FROM growth_asset WHERE content_id = ?').run(id)
  getDb().prepare('DELETE FROM growth_decomp WHERE content_id = ?').run(id)
  getDb().prepare('DELETE FROM growth_content WHERE id = ?').run(id)
}

export function insertAsset(input: {
  contentId: number
  kind: GrowthAsset['kind']
  sha256?: string
  mime?: string
  size?: number
  width?: number
  height?: number
  durationMs?: number
  relPath: string
  thumbRelPath?: string
  sourceMark?: string
}): number {
  const res = getDb()
    .prepare(
      `
      INSERT INTO growth_asset (
        content_id, kind, sha256, mime, size, width, height, duration_ms,
        rel_path, thumb_rel_path, source_mark, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    )
    .run(
      input.contentId,
      input.kind,
      input.sha256 ?? '',
      input.mime ?? '',
      toNum(input.size),
      toNum(input.width),
      toNum(input.height),
      toNum(input.durationMs),
      input.relPath,
      input.thumbRelPath ?? '',
      input.sourceMark ?? 'ref',
      Date.now()
    )
  return Number(res.lastInsertRowid)
}

export function setDecomp(
  contentId: number,
  decomp: {
    modelVer?: string
    structure?: Record<string, unknown> | null
    visual?: Record<string, unknown> | null
    commentTopics?: string[]
  }
): void {
  const now = Date.now()
  const existing = getDb()
    .prepare('SELECT id FROM growth_decomp WHERE content_id = ?')
    .get(contentId) as { id: number } | undefined
  if (existing) {
    getDb()
      .prepare(
        `
        UPDATE growth_decomp SET
          model_ver = ?, structure_json = ?, visual_json = ?, comment_topics_json = ?
        WHERE content_id = ?
      `
      )
      .run(
        decomp.modelVer ?? '',
        JSON.stringify(decomp.structure ?? {}),
        JSON.stringify(decomp.visual ?? {}),
        JSON.stringify(decomp.commentTopics ?? []),
        contentId
      )
    return
  }
  getDb()
    .prepare(
      `
      INSERT INTO growth_decomp (content_id, model_ver, structure_json, visual_json, comment_topics_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `
    )
    .run(
      contentId,
      decomp.modelVer ?? '',
      JSON.stringify(decomp.structure ?? {}),
      JSON.stringify(decomp.visual ?? {}),
      JSON.stringify(decomp.commentTopics ?? []),
      now
    )
}

/** 批量更新(用途/状态/备注), 返回成功条数 */
export function batchPatchContents(
  ids: number[],
  patch: Partial<Pick<GrowthContentItem, 'usage' | 'status' | 'note'>>
): number {
  let ok = 0
  for (const id of ids) {
    if (updateContentFields(id, patch)) ok += 1
  }
  return ok
}

/** 批量删除(含资产/拆解), 返回删除条数 */
export function batchDeleteContents(ids: number[]): number {
  let ok = 0
  for (const id of ids) {
    const exists = getDb().prepare('SELECT id FROM growth_content WHERE id = ?').get(id)
    if (exists) {
      deleteContent(id)
      ok += 1
    }
  }
  return ok
}

/** 删除某素材的资产行(可按类型), 用于重新下载前清理 */
export function deleteAssetRows(contentId: number, kinds?: string[]): number {
  if (!kinds || kinds.length === 0) {
    const res = getDb().prepare('DELETE FROM growth_asset WHERE content_id = ?').run(contentId)
    return res.changes
  }
  const marks = kinds.map(() => '?').join(',')
  const res = getDb()
    .prepare('DELETE FROM growth_asset WHERE content_id = ? AND kind IN (' + marks + ')')
    .run(contentId, ...kinds)
  return res.changes
}
