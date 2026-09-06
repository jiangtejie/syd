import { createLogger } from '../logging'
import {
  cleanOldReportRuns,
  finishReportRun,
  insertReportRun,
  listDueReportJobs,
  listReportJobs,
  markReportJobRun,
  openJobRunConfig,
  setReportJobNextAt
} from '../../db/repos/reportRepo'
import { runChatSyncJob } from './chatSyncRunner'

/**
 * 数据上报 · 调度内核。
 * - 15s 心跳扫描到点任务;单任务不重叠(running 跳过),手动触发与自动共用同一执行器;
 * - 每轮:插 running 历史 → 执行 → 落结果 → 推进 next_at(interval/daily 从本轮结束时间算,
 *   manual 不参与自动调度);启用态任务 next_at 为空/过期时按当前时间补算;
 * - 应用退出 stopReportScheduler():中止在跑任务并等待清理(PG 连接由 runner finally 释放)。
 */

const schedLog = createLogger('report')
const HEARTBEAT_MS = 15_000
const RUN_STATUS = { OK: 'ok', FAIL: 'fail', INTERRUPTED: 'interrupted' } as const

const running = new Map<number, AbortController>()
let timer: ReturnType<typeof setInterval> | null = null
let stopped = false
let cleanAt = Date.now()

export interface JobRunOutcome {
  ok: boolean
  error?: string
  added: number
  sessionsOk: number
  sessionsSkip: number
  errors: string[]
  interrupted: boolean
  summary: string
}

function parseDaily(s: string): { h: number; m: number } | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s ?? '')
  return m ? { h: Number(m[1]), m: Number(m[2]) } : null
}

/** 从 fromMs 起下一次触发时间(interval/daily);manual 恒为 null */
export function nextRunAt(
  kind: 'interval' | 'daily' | 'manual',
  intervalSec: number,
  dailyTime: string,
  fromMs: number
): number | null {
  if (kind === 'interval') return fromMs + Math.max(30, Math.floor(intervalSec || 0)) * 1000
  if (kind === 'daily') {
    const d = parseDaily(dailyTime)
    if (!d) return null
    const at = new Date(fromMs)
    at.setHours(d.h, d.m, 0, 0)
    if (at.getTime() <= fromMs + 5000) at.setDate(at.getDate() + 1)
    return at.getTime()
  }
  return null
}

export function isReportJobRunning(jobId: number): boolean {
  return running.has(jobId)
}

async function executeJob(jobId: number, trigger: string): Promise<JobRunOutcome> {
  if (running.has(jobId)) {
    return {
      ok: false,
      error: '任务正在执行中',
      added: 0,
      sessionsOk: 0,
      sessionsSkip: 0,
      errors: [],
      interrupted: false,
      summary: '跳过(上一轮仍在执行)'
    }
  }
  const controller = new AbortController()
  running.set(jobId, controller)
  const started = Date.now()
  const runId = insertReportRun({
    jobId,
    trigger,
    status: 'running',
    startedAt: started
  })
  try {
    const cfg = openJobRunConfig(jobId)
    if (!cfg) {
      const err = '任务配置缺失或已损坏,请编辑后重试'
      finishReportRun(runId, RUN_STATUS.FAIL, 0, 0, 0, err, Date.now())
      markReportJobRun(jobId, 'fail', err, Date.now())
      return {
        ok: false,
        error: err,
        added: 0,
        sessionsOk: 0,
        sessionsSkip: 0,
        errors: [err],
        interrupted: false,
        summary: err
      }
    }
    const res = await runChatSyncJob(jobId, cfg, controller.signal)
    const status = res.interrupted
      ? RUN_STATUS.INTERRUPTED
      : res.ok
        ? RUN_STATUS.OK
        : RUN_STATUS.FAIL
    finishReportRun(
      runId,
      status,
      res.added,
      res.sessionsOk,
      res.sessionsSkip,
      res.errors.length > 0 ? res.errors.join('\n') : undefined,
      Date.now()
    )
    markReportJobRun(jobId, status, res.summary, Date.now())
    return res
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e)
    finishReportRun(runId, RUN_STATUS.FAIL, 0, 0, 0, err, Date.now())
    markReportJobRun(jobId, 'fail', err, Date.now())
    return {
      ok: false,
      error: err,
      added: 0,
      sessionsOk: 0,
      sessionsSkip: 0,
      errors: [err],
      interrupted: false,
      summary: err
    }
  } finally {
    running.delete(jobId)
    // 自动任务的下一轮:从本轮结束时间起算(手动触发也刷新,便于日常态一致)
    const info = listReportJobs().find((j) => j.id === jobId)
    if (info && info.enabled) {
      setReportJobNextAt(
        jobId,
        nextRunAt(info.scheduleKind, info.intervalSec, info.dailyTime, Date.now())
      )
    }
  }
}

/** IPC:立即执行一轮(manual 亦可用);返回本轮结果摘要 */
export async function runReportJobNow(
  jobId: number
): Promise<{ ok: boolean; error?: string; summary?: string }> {
  if (!Number.isInteger(jobId)) return { ok: false, error: '参数错误' }
  const res = await executeJob(jobId, 'manual')
  return { ok: res.ok && !res.interrupted, error: res.error, summary: res.summary }
}

/** 补算/推进自动任务的 next_at(启动、保存、启停后调用) */
export function rescheduleReportJobs(): void {
  const now = Date.now()
  for (const j of listReportJobs()) {
    if (!j.enabled) {
      setReportJobNextAt(j.id, null)
      continue
    }
    const cur = j.lastAt ?? 0
    const base = Math.max(now, cur + 1000)
    setReportJobNextAt(j.id, nextRunAt(j.scheduleKind, j.intervalSec, j.dailyTime, base))
  }
}

async function tick(): Promise<void> {
  if (stopped) return
  try {
    const due = listDueReportJobs(Date.now())
    for (const row of due) {
      if (running.has(row.id)) continue // 上轮未结束:本轮到点直接跳过
      // 自动轮:避免应用刚启动就把积压到点任务全部立即执行,间隔型任务补一个最小间隔
      void executeJob(row.id, 'auto').catch((e) => {
        schedLog.error(`job=${row.id} 自动执行异常: ${e instanceof Error ? e.message : e}`)
      })
    }
    if (Date.now() - cleanAt > 6 * 3600 * 1000) {
      cleanAt = Date.now()
      cleanOldReportRuns()
    }
  } catch (e) {
    schedLog.error(`调度心跳异常: ${e instanceof Error ? e.message : e}`)
  }
}

export function startReportScheduler(): void {
  if (timer !== null) return
  stopped = false
  rescheduleReportJobs()
  timer = setInterval(() => void tick(), HEARTBEAT_MS)
  schedLog.info('数据上报调度器已启动(15s 心跳)')
}

/** 退出:中止在跑任务并停止心跳(不等待,进程即将退出;runner finally 自行释放 PG) */
export function stopReportScheduler(): void {
  stopped = true
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
  for (const c of running.values()) c.abort()
}

/** 供删除任务前中止在跑轮次 */
export function abortRunningJob(jobId: number): void {
  running.get(jobId)?.abort()
}
