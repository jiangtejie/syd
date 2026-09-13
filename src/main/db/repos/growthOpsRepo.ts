import { getDb } from '../database'
import type {
  GrowthCrawlTaskView,
  GrowthStats,
  GrowthSubscription,
  GrowthSubscriptionInput
} from '../../../shared/growth'

/** growth_* 任务与订阅访问层：采集订阅 / 采集任务 / 汇总统计。 */

interface SubRow {
  id: number
  name: string
  source_type: string
  vendor: string
  city: string
  biz_type: string
  target_kind: string
  target: string
  store_id: number | null
  enabled: number
  interval_hours: number
  next_at: number | null
  last_status: string
  last_at: number | null
  last_error: string
  created_at: number
  updated_at: number
}

function rowToSub(r: SubRow): GrowthSubscription {
  return {
    id: r.id,
    name: r.name,
    sourceType: (['thirdparty', 'official', 'manual'].includes(r.source_type)
      ? r.source_type
      : 'thirdparty') as GrowthSubscription['sourceType'],
    vendor: r.vendor,
    city: r.city,
    bizType: r.biz_type,
    targetKind: (['keyword', 'account', 'topic', 'rank'].includes(r.target_kind)
      ? r.target_kind
      : 'keyword') as GrowthSubscription['targetKind'],
    target: r.target,
    storeId: r.store_id,
    enabled: r.enabled === 1,
    intervalHours: r.interval_hours,
    nextAt: r.next_at ?? null,
    lastStatus: r.last_status,
    lastAt: r.last_at ?? null,
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

export function listSubscriptions(): GrowthSubscription[] {
  const rows = getDb()
    .prepare('SELECT * FROM growth_subscription ORDER BY created_at DESC, id DESC')
    .all() as unknown as SubRow[]
  return rows.map(rowToSub)
}

export function getSubscription(id: number): GrowthSubscription | null {
  const row = getDb().prepare('SELECT * FROM growth_subscription WHERE id = ?').get(id) as
    SubRow | undefined
  return row ? rowToSub(row) : null
}

export function insertSubscription(input: GrowthSubscriptionInput): number {
  const now = Date.now()
  const res = getDb()
    .prepare(
      `
      INSERT INTO growth_subscription (
        name, source_type, vendor, city, biz_type, target_kind, target, store_id,
        enabled, interval_hours, next_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    )
    .run(
      input.name || input.target || '未命名订阅',
      input.sourceType,
      input.vendor,
      input.city,
      input.bizType,
      input.targetKind,
      input.target,
      input.storeId ?? null,
      input.enabled ? 1 : 0,
      input.intervalHours,
      input.enabled ? now : null,
      now,
      now
    )
  return Number(res.lastInsertRowid)
}

export function updateSubscription(id: number, input: GrowthSubscriptionInput): boolean {
  const res = getDb()
    .prepare(
      `
      UPDATE growth_subscription SET
        name = ?, source_type = ?, vendor = ?, city = ?, biz_type = ?,
        target_kind = ?, target = ?, store_id = ?, interval_hours = ?, updated_at = ?
      WHERE id = ?
    `
    )
    .run(
      input.name || input.target || '未命名订阅',
      input.sourceType,
      input.vendor,
      input.city,
      input.bizType,
      input.targetKind,
      input.target,
      input.storeId ?? null,
      input.intervalHours,
      Date.now(),
      id
    )
  return res.changes > 0
}

/** 启停自动采集; 开启时把 next_at 置为当前, 让最近一个心跳立即接管 */
export function setSubscriptionEnabled(id: number, enabled: boolean): void {
  const now = Date.now()
  getDb()
    .prepare(`UPDATE growth_subscription SET enabled = ?, next_at = ?, updated_at = ? WHERE id = ?`)
    .run(enabled ? 1 : 0, enabled ? now : null, now, id)
}

export function deleteSubscription(id: number): void {
  getDb().prepare('DELETE FROM growth_crawl_task WHERE subscription_id = ?').run(id)
  getDb().prepare('DELETE FROM growth_subscription WHERE id = ?').run(id)
}

/** 到期订阅(启用的自动任务; next_at 为空/过期视为到期) */
export function listDueSubscriptions(now: number): GrowthSubscription[] {
  const rows = getDb()
    .prepare(
      `
      SELECT * FROM growth_subscription
      WHERE enabled = 1 AND (next_at IS NULL OR next_at <= ?)
      ORDER BY next_at IS NULL DESC, next_at ASC
    `
    )
    .all(now) as unknown as SubRow[]
  return rows.map(rowToSub)
}

/** 一次采集后回写: status/error/last_at + 推进 next_at(失败按 30 分钟退避, 避免空转) */
export function markSubscriptionOutcome(
  id: number,
  ok: boolean,
  intervalHours: number,
  error?: string
): void {
  const now = Date.now()
  const delayMs = ok ? Math.max(intervalHours || 1, 1) * 3600 * 1000 : 30 * 60 * 1000
  getDb()
    .prepare(
      `
      UPDATE growth_subscription SET
        last_status = ?, last_error = ?, last_at = ?, next_at = ?, updated_at = ?
      WHERE id = ?
    `
    )
    .run(ok ? 'ok' : 'error', error ?? '', now, now + delayMs, now, id)
}

export function createCrawlTask(subscriptionId: number, trigger: 'auto' | 'manual'): number {
  const res = getDb()
    .prepare(
      `
      INSERT INTO growth_crawl_task (subscription_id, trigger, status, started_at)
      VALUES (?, ?, ?, ?)
    `
    )
    .run(subscriptionId, trigger, 'running', Date.now())
  return Number(res.lastInsertRowid)
}

export function finishCrawlTask(
  id: number,
  outcome: { ok: boolean; fetched?: number; inserted?: number; error?: string }
): void {
  getDb()
    .prepare(
      `
      UPDATE growth_crawl_task SET
        status = ?, fetched = ?, inserted = ?, error = ?, ended_at = ?
      WHERE id = ?
    `
    )
    .run(
      outcome.ok ? 'ok' : 'error',
      outcome.fetched ?? 0,
      outcome.inserted ?? 0,
      outcome.error ?? '',
      Date.now(),
      id
    )
}

export function recentCrawlTasks(limit = 10): GrowthCrawlTaskView[] {
  const rows = getDb()
    .prepare('SELECT * FROM growth_crawl_task ORDER BY id DESC LIMIT ?')
    .all(Math.min(Math.max(limit, 1), 100)) as unknown as Array<{
    id: number
    subscription_id: number
    trigger: string
    status: string
    fetched: number
    inserted: number
    error: string
    started_at: number
    ended_at: number | null
  }>
  return rows.map((r) => ({
    id: r.id,
    subscriptionId: r.subscription_id,
    trigger: r.trigger === 'manual' ? 'manual' : 'auto',
    status: r.status,
    fetched: r.fetched,
    inserted: r.inserted,
    error: r.error,
    startedAt: r.started_at,
    endedAt: r.ended_at
  }))
}

export function growthStats(autoEnabled: boolean, provider: string): GrowthStats {
  const count = (table: string): number => {
    const r = getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
    return r.n
  }
  const last = getDb()
    .prepare('SELECT MAX(last_at) AS at, MAX(last_error) AS err FROM growth_subscription')
    .get() as { at: number | null; err: string | null }
  return {
    contentCount: count('growth_content'),
    assetCount: count('growth_asset'),
    subscriptionCount: count('growth_subscription'),
    autoEnabled,
    provider,
    providerConfigured: !!provider,
    lastCrawlAt: last.at,
    lastCrawlError: last.err ?? ''
  }
}

// ── 爆改产出(只读: 历史数据的展示与导出; 写入路径已收敛到 growthAiRepo) ──

export function listRemixOutputViews(
  contentId: number,
  limit = 30
): import('../../../shared/growth').GrowthRemixOutputView[] {
  const rows = getDb()
    .prepare(
      'SELECT o.*, j.mode AS job_mode, j.created_at AS job_created_at FROM growth_remix_output o LEFT JOIN growth_remix_job j ON j.id = o.job_id WHERE o.content_id = ? ORDER BY o.id DESC LIMIT ?'
    )
    .all(contentId, Math.min(Math.max(limit, 1), 100)) as unknown as Array<{
    id: number
    job_id: number
    content_id: number
    variant: string
    title: string
    copy_text: string
    compliance_json: string
    status: string
    created_at: number
    job_mode: string | null
    job_created_at: number | null
  }>
  const parse = (s: string): string[] => {
    try {
      const v = JSON.parse(s)
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  }
  return rows.map((r) => ({
    id: r.id,
    jobId: r.job_id,
    contentId: r.content_id,
    variant: r.variant,
    jobMode: r.job_mode ?? '',
    jobCreatedAt: r.job_created_at ?? r.created_at,
    title: r.title,
    copy: r.copy_text,
    complianceHints: parse(r.compliance_json),
    status: r.status,
    createdAt: r.created_at
  }))
}

// ── 发布登记 / 效果回填 ──

export function insertMetricSnapshot(
  contentId: number,
  input: {
    channel: string
    likes: number
    collects: number
    comments: number
    shares: number
    follows: number
    leads: number
    amount: number
    outputId?: number | null
  }
): number {
  const res = getDb()
    .prepare(
      'INSERT INTO growth_metric_snapshot (target_type, target_id, channel, output_id, likes, collects, comments, shares, follows, leads, amount, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      'content',
      contentId,
      input.channel,
      input.outputId ?? null,
      input.likes,
      input.collects,
      input.comments,
      input.shares,
      input.follows,
      input.leads,
      input.amount,
      Date.now()
    )
  return Number(res.lastInsertRowid)
}

export function listMetricViews(
  contentId: number,
  limit = 10
): import('../../../shared/growth').GrowthMetricView[] {
  const rows = getDb()
    .prepare(
      'SELECT * FROM growth_metric_snapshot WHERE target_type = ? AND target_id = ? ORDER BY id DESC LIMIT ?'
    )
    .all('content', contentId, Math.min(Math.max(limit, 1), 100)) as unknown as Array<{
    id: number
    channel: string
    output_id: number | null
    likes: number
    collects: number
    comments: number
    shares: number
    follows: number
    leads: number
    amount: number
    captured_at: number
  }>
  return rows.map((r) => ({
    id: r.id,
    channel: r.channel,
    outputId: r.output_id ?? null,
    likes: r.likes,
    collects: r.collects,
    comments: r.comments,
    shares: r.shares,
    follows: r.follows,
    leads: r.leads,
    amount: r.amount,
    capturedAt: r.captured_at
  }))
}

/** 营销概览(看板用): 素材/拆解/爆改/发布/线索与最近发布登记 */
export function growthOverview(): import('../../../shared/growth').GrowthOverview {
  const db = getDb()
  const one = (sql: string): number => {
    const row = db.prepare(sql).get() as { n: number }
    return row.n
  }
  const sum = db
    .prepare(
      'SELECT COALESCE(SUM(leads),0) AS leads, COALESCE(SUM(amount),0) AS amount FROM growth_metric_snapshot'
    )
    .get() as { leads: number; amount: number }
  const recent = db
    .prepare(
      `SELECT m.*, c.title AS content_title FROM growth_metric_snapshot m
       LEFT JOIN growth_content c ON c.id = m.target_id
       ORDER BY m.id DESC LIMIT 6`
    )
    .all() as unknown as Array<{
    id: number
    channel: string
    output_id: number | null
    likes: number
    collects: number
    comments: number
    shares: number
    follows: number
    leads: number
    amount: number
    captured_at: number
    content_title: string | null
  }>
  return {
    contentCount: one('SELECT COUNT(*) AS n FROM growth_content'),
    decompCount: one('SELECT COUNT(DISTINCT content_id) AS n FROM growth_decomp'),
    remixOutputCount: one('SELECT COUNT(*) AS n FROM growth_remix_output'),
    publishedContentCount: one('SELECT COUNT(DISTINCT target_id) AS n FROM growth_metric_snapshot'),
    totalLeads: sum.leads,
    totalAmount: sum.amount,
    recentMetrics: recent.map((r) => ({
      id: r.id,
      channel: r.channel,
      outputId: r.output_id ?? null,
      likes: r.likes,
      collects: r.collects,
      comments: r.comments,
      shares: r.shares,
      follows: r.follows,
      leads: r.leads,
      amount: r.amount,
      capturedAt: r.captured_at,
      contentTitle: r.content_title ?? ''
    }))
  }
}
