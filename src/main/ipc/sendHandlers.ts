import { ipcMain } from 'electron'
import {
  enqueueSend,
  getSendStatus,
  resetCircuit,
  stopSending,
  type SendMode
} from '../services/send/sendService'
import { countRecentDays, sendOverview } from '../db/repos/sendLog'

/**
 * 发送执行 IPC（T8，方案 §6 回复流程）。
 * 人工发送与建议发送统一走全局串行队列（sendService），保证行为一致、可审计。
 */
export function registerSendHandlers(): void {
  ipcMain.handle(
    'cs:reply:sendText',
    async (
      _e,
      args: { wxid: string; sessionId: string; targetName: string; text: string; source?: string }
    ) => {
      try {
        const mode: SendMode = args.source === 'kb_direct' ? 'auto' : 'manual'
        const r = await enqueueSend({
          wxid: args.wxid,
          sessionId: args.sessionId,
          targetName: args.targetName,
          text: args.text,
          mode,
          source: args.source || 'manual'
        })
        return { ok: true, result: r } as const
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : '发送失败'
        } as const
      }
    }
  )

  ipcMain.handle('cs:reply:getSendStatus', () => getSendStatus())
  ipcMain.handle('cs:reply:stats7d', () => countRecentDays(7))
  ipcMain.handle('cs:reply:overview', () => {
    try {
      return sendOverview(7)
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : '统计失败' }
    }
  })
  ipcMain.handle('cs:reply:resetCircuit', () => {
    resetCircuit()
    return { ok: true }
  })
  ipcMain.handle('cs:reply:stopAll', () => {
    stopSending()
    return { ok: true }
  })
}
