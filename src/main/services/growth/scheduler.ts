import { createLogger } from '../logging'
import { getGrowthConfig } from './config'
import { listDueSubscriptions } from '../../db/repos/growthOpsRepo'
import { runCrawl, isCrawlRunning } from './collector/service'

/**
 * growth 心跳调度(仿 report/scheduler): 30s 心跳扫描到期订阅。
 * 前置条件: 总开关 growth.enabled 打开; 未配置数据服务商时失败快速回写, 不空转。
 */

const schedLog = createLogger('growth')
const HEARTBEAT_MS = 30_000

let timer: ReturnType<typeof setInterval> | null = null
let stopped = false

function tick(): void {
  if (stopped) return
  const cfg = getGrowthConfig()
  if (!cfg.autoEnabled) return
  const due = listDueSubscriptions(Date.now())
  for (const sub of due) {
    if (isCrawlRunning(sub.id)) continue
    void runCrawl(sub.id, 'auto').then((out) => {
      if (!out.ok) schedLog.warn('auto crawl ' + String(sub.id) + ': ' + (out.error ?? 'unknown'))
    })
  }
}

export function startGrowthScheduler(): void {
  if (timer) return
  stopped = false
  timer = setInterval(tick, HEARTBEAT_MS)
  // 启动后首个周期立即扫一次, 让启用的订阅尽快进入调度
  setTimeout(() => tick(), 1000)
  schedLog.info('growth scheduler started')
}

export function stopGrowthScheduler(): void {
  stopped = true
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  schedLog.info('growth scheduler stopped')
}
