import type { Database } from 'better-sqlite3-multiple-ciphers'

/**
 * 启动对账：把**上一个进程**留下、永远停在「运行中」的任务改判为 interrupted。
 *
 * 为什么必须做：断电 / 杀进程 / 升级重启后，这些行不会被任何东西收尾 —— 审计页显示
 * 「运行中」、上报页上次状态是「运行中」、群问题水位可能卡住。运营以为系统还在跑，
 * 实际那条通道再也不会自动跑（数字员工停摆尤其隐蔽：客户在群里问，系统一声不响）。
 *
 * 判据用「时间早于本次进程启动」而不是「超过 N 小时」：本次进程自己起、自己收的任务
 * 不会被误伤，正常跑很久的长任务也不会因为跑得久而被动改判。
 *
 * 单独成模块（只依赖类型）是为了能离线自检 —— scripts/task-reconcile-selftest.mjs
 * 在临时库里造「遗留 running 行 + 本轮新起行」，断言只有前者被改判。
 */

export interface ReconcileResult {
  imAudit: number
  reportRun: number
  growthCrawl: number
}

/** 改判后的状态值。终端语义：任务被中断，不是失败也不是成功，可安全重跑。 */
export const INTERRUPTED = 'interrupted'

export const INTERRUPTED_NOTE = '进程重启中断（启动对账改判）'

export function reconcileInterruptedTasks(db: Database, processStartedAt: number): ReconcileResult {
  const out: ReconcileResult = { imAudit: 0, reportRun: 0, growthCrawl: 0 }
  const now = Date.now()
  out.imAudit = db
    .prepare(
      `UPDATE im_audit SET status = ?, error = COALESCE(error, ?), finished_at = ?
       WHERE created_at < ? AND status IN ('queued','running')`
    )
    .run(INTERRUPTED, INTERRUPTED_NOTE, now, processStartedAt).changes
  out.reportRun = db
    .prepare(
      `UPDATE report_run SET status = ?, errors = COALESCE(errors, ?), ended_at = ?
       WHERE started_at < ? AND status = 'running'`
    )
    .run(INTERRUPTED, INTERRUPTED_NOTE, now, processStartedAt).changes
  out.growthCrawl = db
    .prepare(
      `UPDATE growth_crawl_task SET status = ?, error = COALESCE(error, ?), ended_at = ?
       WHERE started_at < ? AND status = 'running'`
    )
    .run(INTERRUPTED, INTERRUPTED_NOTE, now, processStartedAt).changes
  return out
}
