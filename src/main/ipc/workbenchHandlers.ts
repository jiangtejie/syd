import { ipcMain, shell } from 'electron'
import {
  clearChatMessages,
  createChat,
  listChatMessages,
  listChats,
  removeChat,
  renameChat
} from '../db/repos/chatRepo'
import {
  resendWorkbenchMessage,
  retryWorkbenchMessage,
  sendWorkbenchMessage,
  stopWorkbenchChat
} from '../services/ai/workbench/engine'
import { resolveToolApproval } from '../services/ai/workbench/approval'
import { listSkills, setSkillEnabled, skillsRoot } from '../services/ai/workbench/skills'

/** AI 工作台 IPC(会话复用 chat 体系,存储 wxid 带 wb: 前缀与 IM 会话隔离;事件通道 ai:wb)。 */

/** 工作台会话存储命名空间:避免未绑定账号(wxid='')时与飞书 IM 映射会话混列 */
function wbWxid(wxid: string): string {
  return `wb:${String(wxid || '')}`
}

export function registerWorkbenchHandlers(): void {
  ipcMain.handle('cs:wb:listChats', (_e, wxid: string) => {
    try {
      return { ok: true as const, chats: listChats(wbWxid(String(wxid || ''))) }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:wb:messages', (_e, id: number) => {
    if (!Number.isInteger(id)) return { ok: false as const, error: '参数错误' }
    try {
      return { ok: true as const, messages: listChatMessages(id) }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:wb:create', (_e, wxid: string, title: string) => {
    try {
      const id = createChat(
        wbWxid(String(wxid || '')),
        String(title || '').slice(0, 24) || '工作台会话',
        null
      )
      return { ok: true as const, id }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:wb:send', async (_e, id: number, wxid: string, text: string) => {
    if (!Number.isInteger(id)) return { ok: false as const, error: '参数错误' }
    try {
      return await sendWorkbenchMessage(id, String(wxid || ''), String(text ?? ''))
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:wb:retry', async (_e, id: number, wxid: string) => {
    if (!Number.isInteger(id)) return { ok: false as const, error: '参数错误' }
    try {
      return await retryWorkbenchMessage(id, String(wxid || ''))
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:wb:resend', async (_e, id: number, wxid: string, text: string) => {
    if (!Number.isInteger(id)) return { ok: false as const, error: '参数错误' }
    try {
      return await resendWorkbenchMessage(id, String(wxid || ''), String(text ?? ''))
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:wb:stop', (_e, id: number) => {
    if (Number.isInteger(id)) stopWorkbenchChat(id)
    return { ok: true as const }
  })

  ipcMain.handle('cs:wb:approve', (_e, runId: string, ok: boolean) => {
    if (typeof runId !== 'string' || !runId) return { ok: false as const, error: '参数错误' }
    return { ok: resolveToolApproval(runId, !!ok) }
  })

  ipcMain.handle('cs:wb:rename', (_e, id: number, title: string) => {
    if (!Number.isInteger(id)) return { ok: false as const, error: '参数错误' }
    return renameChat(id, String(title || ''))
      ? { ok: true as const }
      : { ok: false as const, error: '会话不存在' }
  })

  ipcMain.handle('cs:wb:remove', (_e, id: number) => {
    if (!Number.isInteger(id)) return { ok: false as const, error: '参数错误' }
    stopWorkbenchChat(id)
    return removeChat(id) ? { ok: true as const } : { ok: false as const, error: '会话不存在' }
  })

  ipcMain.handle('cs:wb:clear', (_e, id: number) => {
    if (!Number.isInteger(id)) return { ok: false as const, error: '参数错误' }
    stopWorkbenchChat(id)
    clearChatMessages(id)
    return { ok: true as const }
  })

  ipcMain.handle('cs:wb:skills', () => {
    try {
      return { ok: true as const, skills: listSkills() }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:wb:toggleSkill', (_e, name: string, enabled: boolean) => {
    if (typeof name !== 'string' || !name) return { ok: false as const, error: '参数错误' }
    return setSkillEnabled(name, !!enabled)
      ? { ok: true as const }
      : { ok: false as const, error: '技能不存在' }
  })

  ipcMain.handle('cs:wb:openSkillsDir', async () => {
    const root = skillsRoot()
    const err = await shell.openPath(root)
    return { ok: true as const, path: root, error: err || undefined }
  })
}
