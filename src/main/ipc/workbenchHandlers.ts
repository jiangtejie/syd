import { BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { writeFile } from 'node:fs/promises'
import {
  clearChatMessages,
  createChat,
  getChatById,
  listChatMessages,
  listChats,
  removeChat,
  renameChat,
  searchChatMessages
} from '../db/repos/chatRepo'
import {
  getWorkbenchReliability,
  resendWorkbenchMessage,
  retryWorkbenchMessage,
  sendWorkbenchMessage,
  stopWorkbenchChat
} from '../services/ai/workbench/engine'
import {
  clearSessionToolAllowed,
  getToolApprovalPrefs,
  resolveToolApproval,
  setSessionToolAllowed,
  setToolApprovalPrefs,
  type ToolApprovalMode
} from '../services/ai/workbench/approval'
import {
  ensureBuiltinSkillSeeded,
  listSkills,
  setSkillEnabled,
  skillsRoot
} from '../services/ai/workbench/skills'
import { readMemoNotes, writeMemoNotes } from '../services/ai/memo'
import { toolCnName } from '../../shared/types'

/** AI 工作台 IPC(会话复用 chat 体系,存储 wxid 带 wb: 前缀与 IM 会话隔离;事件通道 ai:wb)。 */

/** 工作台会话存储命名空间:避免未绑定账号(wxid='')时与飞书 IM 映射会话混列 */
function wbWxid(wxid: string): string {
  return `wb:${String(wxid || '')}`
}

/** 文件名安全化 */
function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, '-').slice(0, 60) || '工作台会话'
}

/** 会话 → Markdown(按时间线顺序:提问/文本段落/工具痕迹/压缩标记/错误) */
function sessionToMarkdown(sessionId: number): { title: string; md: string } | { error: string } {
  const session = getChatById(sessionId)
  if (!session) return { error: '会话不存在' }
  const rows = listChatMessages(sessionId)
  const lines: string[] = []
  lines.push(`# ${session.title || '工作台会话'}`)
  lines.push('')
  lines.push(`> 导出时间:${new Date().toLocaleString()} · 消息 ${rows.length} 条`)
  lines.push('')
  for (const r of rows) {
    let meta: Record<string, unknown> | null = null
    if (r.meta) {
      try {
        const p = JSON.parse(r.meta) as unknown
        if (p && typeof p === 'object') meta = p as Record<string, unknown>
      } catch {
        meta = null
      }
    }
    if (r.role === 'user') {
      lines.push(`## 🙋 我`, '', r.content, '', '---', '')
    } else if (r.kind === 'tool_call') {
      const nameRaw = typeof meta?.name === 'string' && meta.name ? meta.name : ''
      const nameShow = nameRaw ? toolCnName(nameRaw) : '工具'
      const nameRawSuffix = nameRaw && nameRaw !== nameShow ? `(${nameRaw})` : ''
      const fail = meta?.status === 'fail'
      lines.push(`### 🔧 工具调用:${nameShow}${nameRawSuffix}${fail ? '(失败)' : ''}`, '')
      if (typeof meta?.args === 'string' && meta.args) {
        lines.push('- 参数', '', '```json', meta.args, '```', '')
      }
      if (typeof meta?.output === 'string' && meta.output) {
        lines.push('- 结果', '', '```', meta.output, '```', '')
      }
      lines.push('---', '')
    } else if (r.kind === 'compact') {
      lines.push(`> 📌 旧对话已自动压缩`, '', r.content, '', '---', '')
    } else if (r.kind === 'error') {
      lines.push(`> ⚠️ ${r.content}`, '', '---', '')
    } else {
      let body = r.content
      if (typeof meta?.reasoning === 'string' && meta.reasoning) {
        body = `> 💭 思考过程\n>\n${meta.reasoning
          .split('\n')
          .map((l) => `> ${l}`)
          .join('\n')}\n\n${body}`
      }
      lines.push(body, '', '---', '')
    }
  }
  return { title: session.title || '工作台会话', md: lines.join('\n') }
}

export function registerWorkbenchHandlers(): void {
  // 首次启动种子内置技能(回复排版),幂等
  ensureBuiltinSkillSeeded()

  ipcMain.handle('cs:wb:listChats', (_e, wxid: string) => {
    try {
      return { ok: true as const, chats: listChats(wbWxid(String(wxid || ''))) }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /** 会话/消息全文检索(当前账号命名空间) */
  ipcMain.handle('cs:wb:searchChats', (_e, wxid: string, query: string) => {
    try {
      return {
        ok: true as const,
        hits: searchChatMessages(wbWxid(String(wxid || '')), String(query || ''))
      }
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

  ipcMain.handle(
    'cs:wb:send',
    async (_e, id: number, wxid: string, text: string, images?: string[]) => {
      if (!Number.isInteger(id)) return { ok: false as const, error: '参数错误' }
      try {
        return await sendWorkbenchMessage(id, String(wxid || ''), String(text ?? ''), {
          images: Array.isArray(images) ? images : []
        })
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

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

  /** 审批信任:scope=session(本轮该会话免确认)/global(始终允许名单) */
  ipcMain.handle('cs:wb:trustTool', (_e, sid: number, tool: string, scope: string) => {
    if (!Number.isInteger(sid) || typeof tool !== 'string' || !tool) {
      return { ok: false as const, error: '参数错误' }
    }
    if (scope === 'session') {
      setSessionToolAllowed(sid, tool, true)
    } else if (scope === 'global') {
      const prefs = getToolApprovalPrefs()
      if (!prefs.allow.includes(tool)) {
        setToolApprovalPrefs({ ...prefs, allow: [...prefs.allow, tool] })
      }
      setSessionToolAllowed(sid, tool, true)
    } else {
      return { ok: false as const, error: '参数错误' }
    }
    return { ok: true as const }
  })

  /** 全局审批偏好(模式 + 信任/拒绝名单) */
  ipcMain.handle('cs:wb:getApprovalPrefs', () => {
    try {
      return { ok: true as const, prefs: getToolApprovalPrefs() }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(
    'cs:wb:setApprovalPrefs',
    (_e, input: { mode?: string; allow?: string[]; deny?: string[] } | undefined) => {
      const prefs = getToolApprovalPrefs()
      const next: { mode: ToolApprovalMode; allow: string[]; deny: string[] } = {
        mode: input?.mode === 'allow' || input?.mode === 'deny' ? input.mode : 'ask',
        allow: Array.isArray(input?.allow) ? input.allow : prefs.allow,
        deny: Array.isArray(input?.deny) ? input.deny : prefs.deny
      }
      try {
        setToolApprovalPrefs(next)
        return { ok: true as const, prefs: getToolApprovalPrefs() }
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle('cs:wb:rename', (_e, id: number, title: string) => {
    if (!Number.isInteger(id)) return { ok: false as const, error: '参数错误' }
    return renameChat(id, String(title || ''))
      ? { ok: true as const }
      : { ok: false as const, error: '会话不存在' }
  })

  ipcMain.handle('cs:wb:remove', (_e, id: number) => {
    if (!Number.isInteger(id)) return { ok: false as const, error: '参数错误' }
    stopWorkbenchChat(id)
    clearSessionToolAllowed(id)
    return removeChat(id) ? { ok: true as const } : { ok: false as const, error: '会话不存在' }
  })

  ipcMain.handle('cs:wb:clear', (_e, id: number) => {
    if (!Number.isInteger(id)) return { ok: false as const, error: '参数错误' }
    stopWorkbenchChat(id)
    clearChatMessages(id)
    return { ok: true as const }
  })

  /** 跨会话运营备忘(所有 AI 通道共用注入) */
  ipcMain.handle('cs:wb:getMemoNotes', () => {
    try {
      return { ok: true as const, notes: readMemoNotes() }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:wb:setMemoNotes', (_e, notes: string) => {
    try {
      writeMemoNotes(String(notes ?? ''))
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /** 本次运行 AI 通道可靠性统计 */
  ipcMain.handle('cs:wb:reliability', () => {
    try {
      return { ok: true as const, stats: getWorkbenchReliability() }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /** 导出当前会话为 Markdown(选目录保存) */
  ipcMain.handle('cs:wb:exportSession', async (e, id: number) => {
    if (!Number.isInteger(id)) return { ok: false as const, error: '参数错误' }
    try {
      const out = sessionToMarkdown(id)
      if ('error' in out) return { ok: false as const, error: out.error }
      const win = BrowserWindow.fromWebContents(e.sender)
      const saveOpts = {
        title: '导出工作台会话',
        defaultPath: `${safeName(out.title)}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      }
      const pick = win
        ? await dialog.showSaveDialog(win, saveOpts)
        : await dialog.showSaveDialog(saveOpts)
      if (pick.canceled || !pick.filePath) return { ok: false as const, error: '已取消' }
      await writeFile(pick.filePath, out.md, 'utf8')
      return { ok: true as const, file: pick.filePath }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /** 清空当前账号的全部工作台会话(先停生成,不可恢复) */
  ipcMain.handle('cs:wb:removeAll', async (_e, wxid: string) => {
    try {
      const chats = listChats(wbWxid(String(wxid || '')))
      for (const c of chats) {
        stopWorkbenchChat(c.id)
        clearSessionToolAllowed(c.id)
        removeChat(c.id)
      }
      return { ok: true as const, removed: chats.length }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
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
