import { ipcMain } from 'electron'
import {
  enqueueSend,
  enqueueSendFile,
  getSendStatus,
  resetCircuit,
  stopSending,
  type SendMode,
  type SendFilePayload
} from '../services/send/sendService'
import { countRecentDays, sendOverview } from '../db/repos/sendLog'
import { basename } from 'path'

/**
 * 发送执行 IPC（T8，方案 §6 回复流程）。
 * 人工发送、建议发送与文件/图片发送统一走全局串行队列（sendService），保证行为一致、可审计。
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

  ipcMain.handle(
    'cs:reply:sendFile',
    async (
      _e,
      args: {
        wxid: string
        sessionId: string
        targetName: string
        path: string
        kind: 'image' | 'file'
        source?: string
      }
    ) => {
      try {
        const kind = args.kind === 'image' ? 'image' : 'file'
        if (!args.path || typeof args.path !== 'string') {
          return { ok: false as const, error: '文件路径缺失' }
        }
        const payload: SendFilePayload = {
          path: args.path,
          kind,
          name: basename(args.path).slice(0, 120)
        }
        const mode: SendMode = args.source === 'kb_direct' ? 'auto' : 'manual'
        const r = await enqueueSendFile({
          wxid: args.wxid,
          sessionId: args.sessionId,
          targetName: args.targetName,
          file: payload,
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
