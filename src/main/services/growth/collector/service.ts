import { createLogger } from '../../logging'
import {
  createCrawlTask,
  finishCrawlTask,
  getSubscription,
  markSubscriptionOutcome
} from '../../../db/repos/growthOpsRepo'
import { insertContent } from '../../../db/repos/growthRepo'
import { getGrowthConfig } from '../config'
import { adapterOf } from './thirdparty'
import { broadcastGrowth } from '../events'

const crawlLog = createLogger('growth')
/** 单订阅同时只允许一个采集在跑(含手动触发) */
const runningSubs = new Set<number>()

export function isCrawlRunning(subscriptionId: number): boolean {
  return runningSubs.has(subscriptionId)
}

export interface CrawlOutcome {
  ok: boolean
  fetched: number
  inserted: number
  error?: string
}

/**
 * 执行一次订阅采集(S 级第三方数据服务)。
 * 供应商未配置/未接入时快速失败并回写订阅状态, 不占用队列。
 * 合规: 只调用供应商开放 API, 严格遵守配额与频率(硬编码, 无逃生口)。
 */
export async function runCrawl(
  subscriptionId: number,
  trigger: 'auto' | 'manual'
): Promise<CrawlOutcome> {
  if (runningSubs.has(subscriptionId)) {
    return { ok: false, fetched: 0, inserted: 0, error: '该订阅正在采集中, 请稍后再试' }
  }
  const sub = getSubscription(subscriptionId)
  if (!sub) return { ok: false, fetched: 0, inserted: 0, error: '订阅不存在' }
  const cfg = getGrowthConfig()
  if (!cfg.provider) {
    const err = '尚未配置数据服务商: 请到 增长-数据服务 填写供应商标识与 API Key'
    markSubscriptionOutcome(sub.id, false, sub.intervalHours, err)
    return { ok: false, fetched: 0, inserted: 0, error: err }
  }
  const adapter = adapterOf(cfg.provider)
  if (!adapter) {
    const err = '数据服务商适配器未接入: ' + cfg.provider + '(Phase 1 提供; 当前可先用链接解析入库)'
    markSubscriptionOutcome(sub.id, false, sub.intervalHours, err)
    return { ok: false, fetched: 0, inserted: 0, error: err }
  }
  if (!cfg.apiKey) {
    const err = '数据服务商 API Key 未配置'
    markSubscriptionOutcome(sub.id, false, sub.intervalHours, err)
    return { ok: false, fetched: 0, inserted: 0, error: err }
  }
  runningSubs.add(subscriptionId)
  const taskId = createCrawlTask(subscriptionId, trigger)
  broadcastGrowth({
    kind: 'crawl',
    subscriptionId,
    status: 'running',
    detail: '开始采集: ' + sub.name,
    at: Date.now()
  })
  try {
    const items = await adapter.hotRank({
      city: sub.city,
      bizType: sub.bizType,
      target: sub.target,
      windowDays: 90
    })
    let inserted = 0
    for (const it of items) {
      if (!it.platformItemId) continue
      const res = insertContent({
        dedupeKey: it.origin + ':' + it.platformItemId,
        origin: it.origin,
        kind: it.kind,
        platformItemId: it.platformItemId,
        title: it.title,
        text: it.text,
        authorName: it.authorName,
        authorId: it.authorId,
        link: it.link,
        publishedAt: it.publishedAt ?? null,
        interactions: it.interactions,
        note: '来源: 数据服务商 ' + adapter.label + ' 订阅 #' + String(subscriptionId)
      })
      if (!res.existed) inserted += 1
    }
    finishCrawlTask(taskId, { ok: true, fetched: items.length, inserted })
    markSubscriptionOutcome(sub.id, true, sub.intervalHours)
    broadcastGrowth({
      kind: 'crawl',
      subscriptionId,
      status: 'done',
      detail: '采集完成: 拉取 ' + String(items.length) + ' 条, 新入库 ' + String(inserted) + ' 条',
      at: Date.now()
    })
    return { ok: true, fetched: items.length, inserted }
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e)
    finishCrawlTask(taskId, { ok: false, error: err })
    markSubscriptionOutcome(sub.id, false, sub.intervalHours, err)
    crawlLog.warn('crawl failed sub=' + String(subscriptionId) + ': ' + err)
    broadcastGrowth({
      kind: 'crawl',
      subscriptionId,
      status: 'error',
      detail: err,
      at: Date.now()
    })
    return { ok: false, fetched: 0, inserted: 0, error: err }
  } finally {
    runningSubs.delete(subscriptionId)
  }
}
