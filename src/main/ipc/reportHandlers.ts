import { ipcMain } from 'electron'
import { Client } from 'pg'
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
import { migrateLegacyMediaPaths } from '../services/report/mediaMigration'
import type { ReportJobInput, ReportPgTarget } from '../../shared/types'

/** 旧 chat-sync 媒体归档项目根(其下 media/<会话>/<文件>);迁移历史数据时按序尝试 */
const LEGACY_MEDIA_ROOTS = ['D:/software/a_data/chat-sync']

/** 数据上报·定时任务 IPC(cs:report.*)。口令只进不出,列表以 hasPassword 标记。 */

export function registerReportHandlers(): void {
  ipcMain.handle('cs:report:list', () => {
    try {
      return { ok: true as const, jobs: listReportJobs() }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:report:save', (_e, input: ReportJobInput) => {
    try {
      const r = saveReportJob(input)
      if (!r.ok) return r
      rescheduleReportJobs()
      return { ok: true as const, id: r.id }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
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
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
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
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:report:runNow', async (_e, id: number) => {
    if (!Number.isInteger(id)) return { ok: false as const, error: '参数错误' }
    try {
      return await runReportJobNow(id)
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
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
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle('cs:report:history', (_e, id: number) => {
    if (!Number.isInteger(id)) return { ok: false as const, error: '参数错误' }
    try {
      return { ok: true as const, runs: listReportRuns(id, 20) }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /** 迁移历史媒体到任务当前媒体根,并把 media_path 改写为相对地址(可重复执行) */
  ipcMain.handle('cs:report:migrateMedia', async (_e, id: number) => {
    if (!Number.isInteger(id)) return { ok: false as const, error: '参数错误' }
    const cfg = openJobRunConfig(id)
    if (!cfg) return { ok: false as const, error: '任务配置缺失或已损坏' }
    const c = new Client({
      host: cfg.target.host,
      port: cfg.target.port || 5432,
      database: cfg.target.database,
      user: cfg.target.user,
      password: cfg.target.password ?? '',
      connectionTimeoutMillis: 10_000,
      options: '-c statement_timeout=120000'
    })
    try {
      await c.connect()
      const r = await migrateLegacyMediaPaths(c, cfg.target.schema, {
        accountWxid: cfg.accountWxid,
        mediaDir: cfg.scope.mediaDir,
        legacyDirs: LEGACY_MEDIA_ROOTS,
        dryRun: false
      })
      return {
        ok: true as const,
        scanned: r.scanned,
        migrated: r.migrated,
        converted: r.converted,
        missingSource: r.missingSource,
        skippedOutside: r.skippedOutside,
        errors: r.errors.slice(0, 10)
      }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    } finally {
      await c.end().catch(() => undefined)
    }
  })
}
