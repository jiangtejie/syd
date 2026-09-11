import { ipcMain } from 'electron'
import { listImAccounts } from '../db/repos/imRepo'
import * as repo from '../db/repos/imFileRepo'
import * as files from '../services/im/channelFiles'
import { createLogger } from '../services/logging'
import { fail } from './_util'
import {
  mediaCachePolicy,
  mediaCacheStats,
  pruneAllVoiceCaches,
  pruneMediaCache
} from '../services/media/mediaCache'

/** 渠道接收文件管理 IPC(工作台侧栏「收到的文件」) */

const fileLog = createLogger('files')

export function registerChannelFileHandlers(): void {
  ipcMain.handle(
    'cs:files:list',
    (_e, opts?: { channel?: string; accountId?: number; limit?: number }) => {
      try {
        const rows = repo.listFileRecords({
          channel: opts?.channel,
          accountId: opts?.accountId,
          limit: opts?.limit ?? 500
        })
        const totals = repo.fileTotals()
        // 渠道展示名:附上 IM 账号清单供渲染层按 accountId 标注
        const accounts = listImAccounts().map((a) => ({ id: a.id, name: a.name }))
        return { ok: true as const, files: rows, totals, accounts }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle('cs:files:remove', (_e, ids: unknown) => {
    try {
      const list = Array.isArray(ids) ? ids.filter((n) => Number.isInteger(n)).map(Number) : []
      if (list.length === 0) return { ok: false as const, error: '未选择文件' }
      const { removed } = files.removeFiles(list)
      return { ok: true as const, removed }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('cs:files:reveal', (_e, id: number) => {
    try {
      return { ok: Number.isInteger(id) && files.revealFile(id) }
    } catch (err) {
      return fail(err)
    }
  })

  /** 清理过期(force=手动时忽略自动清理开关);顺带清媒体展示缓存 + 语音缓存 */
  ipcMain.handle('cs:files:prune', (_e, force?: boolean) => {
    try {
      const r1 = files.pruneExpired(force === true)
      const r2 = files.gcOrphans()
      const r3 = pruneMediaCache(force === true)
      const r4 = pruneAllVoiceCaches()
      const totals = repo.fileTotals()
      fileLog.info(
        `手动清理:过期 ${r1.removed} 个,孤儿 ${r2.removed} 个,媒体缓存 ${r3.removed} 个,语音 ${r4.removed} 个`
      )
      return {
        ok: true as const,
        removed: r1.removed + r2.removed + r3.removed + r4.removed,
        totals,
        media: { removed: r3.removed, freedMB: Math.round(r3.freedBytes / 1024 / 1024) }
      }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('cs:files:policy', () => {
    try {
      const p = files.filePolicy()
      // 媒体侧现状:展示缓存大小/文件数 + 归档大小(归档不参与淘汰,单独显示让用户心里有数)
      const media = { ...mediaCachePolicy(), ...mediaCacheStats() }
      return { ok: true as const, ...p, media }
    } catch (err) {
      return fail(err)
    }
  })
}
