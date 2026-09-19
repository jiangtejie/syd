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

// 注: 这里原有 insertMetricSnapshot / listMetricViews（发布登记与效果回填的读写）——
// 登记发布功能已按用户决定下线，写入点与读取点一起删除。老库的 growth_metric_snapshot 行原样留着。

/**
 * 营销概览(看板用): 素材规模三件套。
 *
 * 注: 这里原本还查 growth_metric_snapshot 的已发布素材数 / 线索 / 金额 / 最近登记 ——
 * 登记发布功能下线后那几个字段没有来源了，一并删除（老数据仍在库里，只是不再有任何界面消费它）。
 */
export function growthOverview(): import('../../../shared/growth').GrowthOverview {
  const db = getDb()
  const one = (sql: string): number => {
    const row = db.prepare(sql).get() as { n: number }
    return row.n
  }
  return {
    contentCount: one('SELECT COUNT(*) AS n FROM growth_content'),
    decompCount: one('SELECT COUNT(DISTINCT content_id) AS n FROM growth_decomp'),
    remixOutputCount: one('SELECT COUNT(*) AS n FROM growth_remix_output')
  }
}
