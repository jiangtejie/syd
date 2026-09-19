/**
 * 营销 AI 工作台数据访问: 任务 / 任务产出资产 / 门店与品牌档案 / 候选与产出。
 * 候选与最终产出都存 growth_remix_output(status: candidate|selected|archived, task_id 关联任务)。
 */

import { getDb } from '../database'

export interface GrowthAiTaskView {
  id: number
  contentId: number
  contentTitle: string
  contentKind: string
  contentOrigin: string
  storeId: number | null
  storeName: string
  title: string
  goal: string
  status: string
  sessionId: number | null
  summary: string
  createdAt: number
  updatedAt: number
  lastMessageAt: number | null
  /** 待确认候选数量(列表红点) */
  pendingCandidates: number
  /** 素材封面(本地相对路径, 可空) */
  contentCover: string
  /** 任务相关产出图(本地相对路径, 最多 4 张) */
  outputImages: string[]
}

export interface GrowthStoreInput {
  id?: number
  brandName: string
  name: string
  city: string
  address: string
  bizType: string
  poi: string
  profile: string
  enabled: boolean
}

export interface GrowthStoreView extends GrowthStoreInput {
  id: number
  createdAt: number
  updatedAt: number
}

export interface GrowthOutputAssetView {
  id: number
  outputId: number
  assetId: number | null
  role: string
  source: string
  prompt: string
  note: string
  createdAt: number
  /** 关联本地资产(可空) */
  relPath: string
  kind: string
}

export interface GrowthOutputView {
  id: number
  taskId: number | null
  contentId: number
  variant: string
  title: string
  copy: string
  complianceHints: string[]
  meta: Record<string, unknown>
  status: string
  createdAt: number
  assets: GrowthOutputAssetView[]
}

// ── 任务 ──

export function createTask(input: {
  contentId: number
  storeId: number | null
  title: string
  goal: string
}): number {
  const now = Date.now()
  const res = getDb()
    .prepare(
      // 注: 原 stage 列（拆解/改写/配图/成稿/复核）已删 —— 从来没有任何地方写过它，
      // 界面却按它显示阶段徽标，等于永远显示「拆解」。任务进度以 status + 对话时间线为准。
      'INSERT INTO growth_ai_task (content_id, store_id, title, goal, status, summary, created_at, updated_at, last_message_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(input.contentId, input.storeId, input.title, input.goal, 'drafting', '', now, now, null)
  return Number(res.lastInsertRowid)
}

export function bindTaskSession(taskId: number, sessionId: number): void {
  getDb()
    .prepare('UPDATE growth_ai_task SET session_id = ?, updated_at = ? WHERE id = ?')
    .run(sessionId, Date.now(), taskId)
}

export function updateTask(
  taskId: number,
  patch: Partial<{
    title: string
    goal: string
    status: string
    summary: string
    storeId: number | null
  }>
): void {
  const keys: string[] = []
  const vals: Array<string | number | null> = []
  if (patch.title !== undefined) {
    keys.push('title = ?')
    vals.push(patch.title)
  }
  if (patch.goal !== undefined) {
    keys.push('goal = ?')
    vals.push(patch.goal)
  }
  if (patch.status !== undefined) {
    keys.push('status = ?')
    vals.push(patch.status)
  }
  if (patch.summary !== undefined) {
    keys.push('summary = ?')
    vals.push(patch.summary)
  }
  if (patch.storeId !== undefined) {
    keys.push('store_id = ?')
    vals.push(patch.storeId)
  }
  if (keys.length === 0) return
  vals.push(Date.now(), taskId)
  getDb()
    .prepare('UPDATE growth_ai_task SET ' + keys.join(', ') + ', updated_at = ? WHERE id = ?')
    .run(...vals)
}

export function touchTask(taskId: number): void {
  getDb()
    .prepare('UPDATE growth_ai_task SET last_message_at = ?, updated_at = ? WHERE id = ?')
    .run(Date.now(), Date.now(), taskId)
}

export function removeTask(taskId: number): void {
  const db = getDb()
  db.prepare(
    'DELETE FROM growth_output_asset WHERE output_id IN (SELECT id FROM growth_remix_output WHERE task_id = ?)'
  ).run(taskId)
  db.prepare('DELETE FROM growth_remix_output WHERE task_id = ?').run(taskId)
  db.prepare('DELETE FROM growth_ai_task WHERE id = ?').run(taskId)
}

function taskRowToView(r: Record<string, unknown>): GrowthAiTaskView {
  return {
    id: Number(r.id),
    contentId: Number(r.content_id),
    contentTitle: String(r.content_title ?? ''),
    contentKind: String(r.content_kind ?? ''),
    contentOrigin: String(r.content_origin ?? ''),
    storeId: r.store_id === null || r.store_id === undefined ? null : Number(r.store_id),
    storeName: String(r.store_name ?? ''),
    title: String(r.title ?? ''),
    goal: String(r.goal ?? 'image_text'),
    status: String(r.status ?? 'drafting'),
    sessionId: r.session_id === null || r.session_id === undefined ? null : Number(r.session_id),
    summary: String(r.summary ?? ''),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    lastMessageAt:
      r.last_message_at === null || r.last_message_at === undefined
        ? null
        : Number(r.last_message_at),
    pendingCandidates: Number(r.pending ?? 0),
    contentCover: String(r.content_cover ?? ''),
    outputImages: String(r.output_imgs ?? '')
      .split('|')
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 4)
  }
}

const TASK_SELECT =
  'SELECT t.*, c.title AS content_title, c.kind AS content_kind, c.origin AS content_origin, s.name AS store_name, ' +
  "(SELECT COUNT(*) FROM growth_remix_output o WHERE o.task_id = t.id AND o.status = 'candidate') AS pending, " +
  "(SELECT a.rel_path FROM growth_asset a WHERE a.content_id = t.content_id AND a.kind IN ('cover','image') AND a.rel_path <> '' ORDER BY CASE a.kind WHEN 'cover' THEN 0 ELSE 1 END, a.id ASC LIMIT 1) AS content_cover, " +
  "(SELECT GROUP_CONCAT(rel_path, '|') FROM (SELECT a2.rel_path AS rel_path FROM growth_output_asset oa JOIN growth_asset a2 ON a2.id = oa.asset_id WHERE oa.output_id IN (SELECT o2.id FROM growth_remix_output o2 WHERE o2.task_id = t.id) AND a2.rel_path <> '' ORDER BY oa.id DESC LIMIT 4)) AS output_imgs " +
  'FROM growth_ai_task t LEFT JOIN growth_content c ON c.id = t.content_id ' +
  'LEFT JOIN growth_store s ON s.id = t.store_id '

export function listTasks(limit = 100): GrowthAiTaskView[] {
  const rows = getDb()
    .prepare(
      TASK_SELECT +
        "ORDER BY CASE t.status WHEN 'drafting' THEN 0 ELSE 1 END, t.updated_at DESC LIMIT ?"
    )
    .all(Math.min(Math.max(limit, 1), 300)) as unknown as Record<string, unknown>[]
  return rows.map(taskRowToView)
}

export function getTask(taskId: number): GrowthAiTaskView | null {
  const row = getDb()
    .prepare(TASK_SELECT + 'WHERE t.id = ?')
    .get(taskId) as Record<string, unknown> | undefined
  return row ? taskRowToView(row) : null
}

// ── 门店与品牌档案 ──

export function listStores(): GrowthStoreView[] {
  const rows = getDb()
    .prepare('SELECT * FROM growth_store ORDER BY enabled DESC, id ASC')
    .all() as unknown as Record<string, unknown>[]
  return rows.map((r) => ({
    id: Number(r.id),
    brandName: String(r.brand_name ?? ''),
    name: String(r.name ?? ''),
    city: String(r.city ?? ''),
    address: String(r.address ?? ''),
    bizType: String(r.biz_type ?? ''),
    poi: String(r.poi_json ?? '[]'),
    profile: String(r.profile_json ?? '{}'),
    enabled: Number(r.enabled ?? 1) === 1,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at)
  }))
}

export function saveStore(input: GrowthStoreInput): number {
  const now = Date.now()
  if (input.id && input.id > 0) {
    getDb()
      .prepare(
        'UPDATE growth_store SET brand_name = ?, name = ?, city = ?, address = ?, biz_type = ?, poi_json = ?, profile_json = ?, enabled = ?, updated_at = ? WHERE id = ?'
      )
      .run(
        input.brandName,
        input.name,
        input.city,
        input.address,
        input.bizType,
        input.poi,
        input.profile,
        input.enabled ? 1 : 0,
        now,
        input.id
      )
    return input.id
  }
  const res = getDb()
    .prepare(
      'INSERT INTO growth_store (brand_name, name, city, address, biz_type, poi_json, profile_json, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      input.brandName,
      input.name,
      input.city,
      input.address,
      input.bizType,
      input.poi,
      input.profile,
      input.enabled ? 1 : 0,
      now,
      now
    )
  return Number(res.lastInsertRowid)
}

export function removeStore(id: number): void {
  getDb().prepare('DELETE FROM growth_store WHERE id = ?').run(id)
}

export function getBrandProfile(): { id: number; name: string; profile: string } | null {
  const row = getDb()
    .prepare('SELECT * FROM growth_brand_profile ORDER BY id ASC LIMIT 1')
    .get() as Record<string, unknown> | undefined
  if (!row) return null
  return {
    id: Number(row.id),
    name: String(row.name ?? ''),
    profile: String(row.profile_json ?? '{}')
  }
}

export function saveBrandProfile(name: string, profile: string): number {
  const cur = getBrandProfile()
  const now = Date.now()
  if (cur) {
    getDb()
      .prepare(
        'UPDATE growth_brand_profile SET name = ?, profile_json = ?, updated_at = ? WHERE id = ?'
      )
      .run(name, profile, now, cur.id)
    return cur.id
  }
  const res = getDb()
    .prepare(
      'INSERT INTO growth_brand_profile (name, profile_json, created_at, updated_at) VALUES (?, ?, ?, ?)'
    )
    .run(name, profile, now, now)
  return Number(res.lastInsertRowid)
}

// ── 候选与产出 ──

export function createOutput(input: {
  taskId: number | null
  contentId: number
  variant: string
  title: string
  copy: string
  complianceHints: string[]
  meta: Record<string, unknown>
  status: string
}): number {
  const res = getDb()
    .prepare(
      'INSERT INTO growth_remix_output (variant, title, copy_text, content_id, task_id, compliance_json, meta_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      input.variant,
      input.title,
      input.copy,
      input.contentId,
      input.taskId,
      JSON.stringify(input.complianceHints ?? []),
      JSON.stringify(input.meta ?? {}),
      input.status,
      Date.now()
    )
  return Number(res.lastInsertRowid)
}

export function setOutputStatus(outputId: number, status: string): void {
  getDb().prepare('UPDATE growth_remix_output SET status = ? WHERE id = ?').run(status, outputId)
}

export function removeOutput(outputId: number): void {
  getDb().prepare('DELETE FROM growth_output_asset WHERE output_id = ?').run(outputId)
  getDb().prepare('DELETE FROM growth_remix_output WHERE id = ?').run(outputId)
}

export function addOutputAsset(input: {
  outputId: number
  assetId: number | null
  role: string
  source: string
  prompt: string
  note: string
}): number {
  const res = getDb()
    .prepare(
      'INSERT INTO growth_output_asset (output_id, asset_id, role, source, prompt, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      input.outputId,
      input.assetId,
      input.role,
      input.source,
      input.prompt,
      input.note,
      Date.now()
    )
  return Number(res.lastInsertRowid)
}

/**
 * 删掉某产出下**指定 role** 的图（换封面/换配图用）。
 *
 * 为什么需要：`growth_replace_image` 名叫「替换」，此前实现只是 addOutputAsset —— 换一次多一张，
 * 换三次之后导出包里躺着三张封面（导出按顺序命名 封面/图2/图3，用户根本不知道哪张是最终封面）。
 * 替换就该是真的替换：先按 role 清掉旧图，再落新图。
 */
export function removeOutputAssetsByRole(outputId: number, role: string): number {
  const res = getDb()
    .prepare('DELETE FROM growth_output_asset WHERE output_id = ? AND role = ?')
    .run(outputId, role)
  return Number(res.changes ?? 0)
}

/**
 * 只保留选中的那一张图（候选图「用这张」）。
 * 一次生图会出 N 张图落在同一个产出块里，采用时只该留下用户点的那张；
 * 否则点一张 = 整块 N 张一起进产出（导出包里就多出 N-1 张废图）。
 */
export function keepOnlyOutputAsset(outputId: number, assetId: number): number {
  const db = getDb()
  const hit = db
    .prepare('SELECT COUNT(*) AS n FROM growth_output_asset WHERE output_id = ? AND asset_id = ?')
    .get(outputId, assetId) as { n: number } | undefined
  if (!Number(hit?.n ?? 0)) return -1
  const res = db
    .prepare(
      'DELETE FROM growth_output_asset WHERE output_id = ? AND (asset_id IS NULL OR asset_id <> ?)'
    )
    .run(outputId, assetId)
  return Number(res.changes ?? 0)
}

export function listOutputsByTask(taskId: number, status?: string): GrowthOutputView[] {
  const sql =
    'SELECT * FROM growth_remix_output WHERE task_id = ?' +
    (status ? ' AND status = ?' : '') +
    ' ORDER BY id DESC LIMIT 200'
  const rows = (status
    ? getDb().prepare(sql).all(taskId, status)
    : getDb().prepare(sql).all(taskId)) as unknown as Record<string, unknown>[]
  return rows.map((r) => {
    const out: GrowthOutputView = {
      id: Number(r.id),
      taskId: r.task_id === null || r.task_id === undefined ? null : Number(r.task_id),
      contentId: Number(r.content_id),
      variant: String(r.variant ?? ''),
      title: String(r.title ?? ''),
      copy: String(r.copy_text ?? ''),
      complianceHints: parseArr(r.compliance_json),
      meta: parseObj(r.meta_json),
      status: String(r.status ?? ''),
      createdAt: Number(r.created_at),
      assets: []
    }
    out.assets = listOutputAssets(out.id)
    return out
  })
}

function parseArr(raw: unknown): string[] {
  try {
    const v = JSON.parse(String(raw ?? '[]'))
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function parseObj(raw: unknown): Record<string, unknown> {
  try {
    const v = JSON.parse(String(raw ?? '{}'))
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function listOutputAssets(outputId: number): GrowthOutputAssetView[] {
  const rows = getDb()
    .prepare(
      'SELECT oa.*, a.rel_path AS rel_path, a.kind AS a_kind FROM growth_output_asset oa LEFT JOIN growth_asset a ON a.id = oa.asset_id WHERE oa.output_id = ? ORDER BY oa.id ASC'
    )
    .all(outputId) as unknown as Record<string, unknown>[]
  return rows.map((r) => ({
    id: Number(r.id),
    outputId: Number(r.output_id),
    assetId: r.asset_id === null || r.asset_id === undefined ? null : Number(r.asset_id),
    role: String(r.role ?? 'image'),
    source: String(r.source ?? ''),
    prompt: String(r.prompt ?? ''),
    note: String(r.note ?? ''),
    createdAt: Number(r.created_at),
    relPath: String(r.rel_path ?? ''),
    kind: String(r.a_kind ?? '')
  }))
}

/** 更新产出文本(标题/正文) */
export function updateOutputFields(
  outputId: number,
  patch: { title?: string; copy?: string }
): void {
  const keys: string[] = []
  const vals: string[] = []
  if (patch.title !== undefined) {
    keys.push('title = ?')
    vals.push(patch.title)
  }
  if (patch.copy !== undefined) {
    keys.push('copy_text = ?')
    vals.push(patch.copy)
  }
  if (keys.length === 0) return
  vals.push(String(outputId))
  getDb()
    .prepare('UPDATE growth_remix_output SET ' + keys.join(', ') + ' WHERE id = ?')
    .run(...vals)
}

/** 会话域标记(chat_session.scope) */
export function setChatScope(sessionId: number, scope: string): void {
  getDb().prepare('UPDATE chat_session SET scope = ? WHERE id = ?').run(scope, sessionId)
}
