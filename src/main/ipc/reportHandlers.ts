import { ipcMain } from 'electron'
import {
  listReportJobs,
  saveReportJob,
  removeReportJob,
  setReportJobEnabled,
  listReportRuns,
  openJobRunConfig
} from '../db/repos/reportRepo'
import {
  runReportJobNow,
  rescheduleReportJobs,
  abortRunningJob
} from '../services/report/scheduler'
import { testPgConnection } from '../services/report/pgWriter'
import type { ReportJobInput, ReportPgTarget } from '../../shared/types'
import { fail } from './_util'

/** 数据上报·定时任务 IPC(cs:report.*)。口令只进不出,列表以 hasPassword 标记。 */

/** 数据上报·定时任务 IPC(cs:report.*)。口令只进不出,列表以 hasPassword 标记。 */

export function registerReportHandlers(): void {
  ipcMain.handle('cs:report:list', () => {
    try {
      return { ok: true as const, jobs: listReportJobs() }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('cs:report:save', (_e, input: ReportJobInput) => {
    try {
      const r = saveReportJob(input)
      if (!r.ok) return r
      rescheduleReportJobs()
      return { ok: true as const, id: r.id }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('cs:report:remove', (_e, id: number) => {
    if (!Number.isInteger(id)) return { ok: false as const, error: '参数错误' }
    try {
      abortRunningJob(id)
      if (!removeReportJob(id)) return { ok: false as const, error: '任务不存在' }
      rescheduleReportJobs()
      return { ok: true as const }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('cs:report:setEnabled', (_e, id: number, enabled: boolean) => {
    if (!Number.isInteger(id)) return { ok: false as const, error: '参数错误' }
    try {
      if (!enabled) abortRunningJob(id)
      const r = setReportJobEnabled(id, !!enabled)
      if (!r.ok) return r
      rescheduleReportJobs()
      return { ok: true as const }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('cs:report:runNow', async (_e, id: number) => {
    if (!Number.isInteger(id)) return { ok: false as const, error: '参数错误' }
    try {
      return await runReportJobNow(id)
    } catch (err) {
      return fail(err)
    }
  })

  /** 取消正在执行的一轮(在跑任务停止,已入库数据保留,游标不推进) */
  ipcMain.handle('cs:report:cancel', (_e, id: number) => {
    if (!Number.isInteger(id)) return { ok: false as const, error: '参数错误' }
    abortRunningJob(id)
    return { ok: true as const }
  })

  /** 测试连接:优先用表单新填口令;未填且给了 jobId 时沿用任务内已存密文 */
  ipcMain.handle(
    'cs:report:testConn',
    async (_e, opts: { target?: ReportPgTarget; jobId?: number }) => {
      try {
        let target = opts?.target
        if ((!target?.password || !target.password.trim()) && opts?.jobId) {
          const cfg = openJobRunConfig(opts.jobId)
          if (cfg) {
            target = {
              host: cfg.target.host,
              port: cfg.target.port,
              database: cfg.target.database,
              user: cfg.target.user,
              schema: cfg.target.schema,
              password: cfg.target.password
            }
          }
        }
        if (!target) return { ok: false as const, error: '缺少连接参数' }
        return await testPgConnection(target)
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle('cs:report:history', (_e, id: number) => {
    if (!Number.isInteger(id)) return { ok: false as const, error: '参数错误' }
    try {
      return { ok: true as const, runs: listReportRuns(id, 20) }
    } catch (err) {
      return fail(err)
    }
  })
}
