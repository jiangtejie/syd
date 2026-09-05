import { ipcMain, shell } from 'electron'
import { createLogger, ensureLogsDir, recentLogs, clearLogs } from '../services/logging'

/** 日志管理 IPC(设置 → 日志 tab):近实时尾部/打开目录/清空 */

const log = createLogger('logs')

export function registerLogHandlers(): void {
  ipcMain.handle(
    'cs:logs:recent',
    (
      _e,
      opts: {
        minLevel?: 'debug' | 'info' | 'warn' | 'error'
        scope?: string
        query?: string
        max?: number
      }
    ) => {
      try {
        const max = Math.min(Math.max(Math.floor(Number(opts?.max) || 500), 1), 2000)
        return { ok: true as const, entries: recentLogs({ ...opts, max }) }
      } catch (err) {
        return {
          ok: false as const,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }
  )

  ipcMain.handle('cs:logs:openFolder', () => {
    try {
      const dir = ensureLogsDir()
      void shell.openPath(dir)
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:logs:clear', () => {
    try {
      const { removed } = clearLogs()
      log.info(`日志已清空(移除 ${removed} 个文件)`)
      return { ok: true as const, removed }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
