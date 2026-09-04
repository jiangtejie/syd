import { ipcMain } from 'electron'
import {
  confirmToolRun,
  retryChat,
  sendChatMessage,
  stopChat,
  stopChatById,
  clearChat,
  chatRepo
} from '../services/ai/chat/service'
import { listChatMessages } from '../db/repos/chatRepo'

/**
 * AI 助手 IPC(docs/ai-assistant-design.md §5)。
 * 渲染→主:cs:aichat:*;主→渲染事件:'ai:chat'(AiChatEvent)。
 */
export function registerAiChatHandlers(): void {
  ipcMain.handle('cs:aichat:listChats', (_e, wxid: string) => {
    try {
      return { ok: true as const, chats: chatRepo.listChats(wxid ?? '') }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:aichat:messages', (_e, sessionId: number) => {
    if (!Number.isInteger(sessionId)) return { ok: false as const, error: '参数错误' }
    try {
      return { ok: true as const, messages: listChatMessages(sessionId) }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:aichat:renameChat', (_e, sessionId: number, title: string) => {
    if (!Number.isInteger(sessionId)) return { ok: false as const, error: '参数错误' }
    try {
      chatRepo.renameChat(sessionId, title)
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:aichat:removeChat', (_e, sessionId: number) => {
    if (!Number.isInteger(sessionId)) return { ok: false as const, error: '参数错误' }
    try {
      stopChatById(sessionId) // 先中止该会话在跑的生成,防孤儿任务写已删会话
      chatRepo.removeChat(sessionId)
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:aichat:clearChat', (_e, sessionId: number) => {
    if (!Number.isInteger(sessionId)) return { ok: false as const, error: '参数错误' }
    try {
      stopChatById(sessionId)
      clearChat(sessionId)
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(
    'cs:aichat:send',
    async (_e, input: { wxid: string; chatId?: number; agentId?: string | null; text: string }) =>
      sendChatMessage(input ?? { wxid: '', text: '' })
  )

  ipcMain.handle('cs:aichat:stop', (_e, wxid: string, sessionId: number) => {
    stopChat(wxid ?? '', sessionId)
    return { ok: true as const }
  })

  ipcMain.handle(
    'cs:aichat:retry',
    async (_e, wxid: string, sessionId: number, agentId?: string | null) =>
      retryChat(wxid ?? '', sessionId, agentId)
  )

  ipcMain.handle('cs:aichat:confirmTool', (_e, runId: string, ok: boolean) => {
    if (confirmToolRun(runId, !!ok)) return { ok: true as const }
    return { ok: false as const, error: '确认已过期或不存在' }
  })

  ipcMain.handle('cs:aichat:setAgent', (_e, sessionId: number, agentId: string | null) => {
    if (!Number.isInteger(sessionId)) return { ok: false as const, error: '参数错误' }
    try {
      chatRepo.setChatAgent(sessionId, agentId)
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
