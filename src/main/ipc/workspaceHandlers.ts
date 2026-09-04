import { ipcMain } from 'electron'
import {
  createWorkspaceSession,
  listWorkspaceMessages,
  listWorkspaceSessions,
  removeWorkspaceSession,
  renameWorkspaceSession
} from '../db/repos/workspaceRepo'
import {
  confirmWorkspaceTool,
  retryWorkspaceMessage,
  sendWorkspaceMessage,
  stopWorkspaceChat
} from '../services/workspace/runner'
import { buildTree } from '../services/workspace/tools'

/** 工作区 Agent IPC(桌面入口 v1;事件通道 ai:ws)。 */

export function registerWorkspaceHandlers(): void {
  ipcMain.handle('cs:ws:list', () => {
    try {
      return { ok: true as const, sessions: listWorkspaceSessions() }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:ws:create', (_e, cwd: string, title: string) => {
    const dir = String(cwd || '').trim()
    if (!dir) return { ok: false as const, error: '请选择工作目录' }
    try {
      const id = createWorkspaceSession(dir, String(title || '').trim())
      return { ok: true as const, id }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:ws:rename', (_e, id: number, title: string) => {
    if (!Number.isInteger(id)) return { ok: false as const, error: '参数错误' }
    try {
      return renameWorkspaceSession(id, String(title || ''))
        ? { ok: true as const }
        : { ok: false as const, error: '会话不存在' }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:ws:remove', (_e, id: number) => {
    if (!Number.isInteger(id)) return { ok: false as const, error: '参数错误' }
    try {
      stopWorkspaceChat(id)
      return removeWorkspaceSession(id)
        ? { ok: true as const }
        : { ok: false as const, error: '会话不存在' }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:ws:messages', (_e, id: number) => {
    if (!Number.isInteger(id)) return { ok: false as const, error: '参数错误' }
    try {
      return { ok: true as const, messages: listWorkspaceMessages(id) }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:ws:send', async (_e, id: number, text: string) => {
    if (!Number.isInteger(id)) return { ok: false as const, error: '参数错误' }
    try {
      return await sendWorkspaceMessage(id, String(text ?? ''))
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:ws:retry', async (_e, id: number) => {
    if (!Number.isInteger(id)) return { ok: false as const, error: '参数错误' }
    try {
      return await retryWorkspaceMessage(id)
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:ws:stop', (_e, id: number) => {
    if (Number.isInteger(id)) stopWorkspaceChat(id)
    return { ok: true as const }
  })

  ipcMain.handle('cs:ws:confirm', (_e, runId: string, ok: boolean) => {
    if (typeof runId !== 'string' || !runId) return { ok: false as const, error: '参数错误' }
    return { ok: confirmWorkspaceTool(runId, !!ok) }
  })

  ipcMain.handle('cs:ws:preview', (_e, cwd: string) => {
    const dir = String(cwd || '').trim()
    if (!dir) return { ok: false as const, error: '请选择工作目录' }
    try {
      return { ok: true as const, tree: buildTree(dir) }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
