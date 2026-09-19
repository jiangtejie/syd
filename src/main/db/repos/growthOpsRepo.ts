import { getDb } from '../database'
import type { GrowthStats } from '../../../shared/growth'

/**
 * growth_* 汇总统计 + 产出/回流读取层。
 *
 * 注: 原有的「采集订阅 + 采集任务」访问层（listSubscriptions / insertSubscription /
 * markSubscriptionOutcome / createCrawlTask …）已随采集链路下线删除 —— 第三方数据服务适配器
 * 从未被 registerAdapter 注册过，这条链路在结构上不可能成功（见 ARCHITECTURE §9）。
 */

export function growthStats(): GrowthStats {
  const count = (table: string): number => {
    const r = getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
    return r.n
  }
  return {
    contentCount: count('growth_content'),
    assetCount: count('growth_asset')
  }
}

// ── 爆改产出(只读: 历史数据的展示与导出; 写入路径已收敛到 growthAiRepo) ──

export function listRemixOutputViews(
  contentId: number,
  limit = 30
): import('../../../shared/growth').GrowthRemixOutputView[] {
  // 注: 这里原本 LEFT JOIN growth_remix_job 取 job.mode / job.created_at。那张表早已没有写入点
  // （新产出走 AI 工作台，job_id 恒为 0），JOIN 出来的两个字段渲染端也从未消费 —— 连同表一起删了。
  const rows = getDb()
    .prepare(
      'SELECT o.* FROM growth_remix_output o WHERE o.content_id = ? ORDER BY o.id DESC LIMIT ?'
    )
    .all(contentId, Math.min(Math.max(limit, 1), 100)) as unknown as Array<{
    id: number
    content_id: number
    variant: string
    title: string
    copy_text: string
    compliance_json: string
    status: string
    created_at: number
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
    contentId: r.content_id,
    variant: r.variant,
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
