import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from './logging'

/**
 * 主进程崩溃兜底。
 *
 * 以前全仓没有 uncaughtException / unhandledRejection / crashReporter —— 主进程一崩，
 * 应用直接消失，用户只会说「软件自己关了」，开发拿不到堆栈、也拿不到崩溃前的任务状态。
 *
 * 这里只做最低成本的三件事：落一份 crash-<ts>.log、留一个「上次异常退出」标记（下次启动
 * 可提示与导出）、写进统一日志。**故意不退出进程**：桌面端常驻后台并跑着群问题调度、
 * 数据上报、数字员工值班，因一次未捕获异常就整体退出，代价比带着已知异常继续跑更大。
 */

const crashLog = createLogger('crash')

function logDir(): string {
  return join(app.getPath('userData'), 'logs')
}

function markerPath(): string {
  return join(app.getPath('userData'), 'crash-marker.json')
}

export interface CrashMarker {
  at: number
  kind: string
  message: string
  logFile: string
}

/**
 * 记一条崩溃。任何一步失败都不允许再抛 —— 崩溃处理器里抛异常会变成递归崩溃。
 * 返回落盘的日志路径（失败时为空串）。
 */
export function recordCrash(kind: string, err: unknown): string {
  const at = Date.now()
  const text = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
  let logFile = ''
  try {
    const dir = logDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    logFile = join(dir, `crash-${new Date(at).toISOString().replace(/[:.]/g, '-')}.log`)
    appendFileSync(logFile, `[${new Date(at).toISOString()}] ${kind}\n${text}\n`, 'utf8')
    const marker: CrashMarker = { at, kind, message: text.slice(0, 500), logFile }
    writeFileSync(markerPath(), JSON.stringify(marker), 'utf8')
  } catch {
    /* 落盘失败也不能影响进程存活 */
  }
  try {
    crashLog.error(`${kind}: ${text.slice(0, 800)}`)
  } catch {
    /* 数据库可能还没就绪：日志写不进去就算了 */
  }
  return logFile
}

/** 读走「上次异常退出」标记（读到即清除，避免每次启动都提示） */
export function consumeCrashMarker(): CrashMarker | null {
  try {
    const p = markerPath()
    if (!existsSync(p)) return null
    const raw = readFileSync(p, 'utf8')
    rmSync(p, { force: true })
    const m = JSON.parse(raw) as CrashMarker
    return typeof m?.at === 'number' ? m : null
  } catch {
    return null
  }
}

let installed = false

/** 注册进程级兜底（幂等）。要在建库之前调用：启动早期就崩的话也要留下痕迹。 */
export function installCrashGuard(): void {
  if (installed) return
  installed = true
  process.on('uncaughtException', (err) => {
    recordCrash('uncaughtException', err)
  })
  process.on('unhandledRejection', (reason) => {
    recordCrash('unhandledRejection', reason)
  })
}
