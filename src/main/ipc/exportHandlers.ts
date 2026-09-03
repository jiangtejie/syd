import { ipcMain, shell, BrowserWindow } from 'electron'
import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { exportChat, exportBusiness, type ChatExportOptions, type ProgressEvent } from '../services/export/exportService'

/**
 * 数据导出 IPC。
 * cs:export:chat(wxid, opts) → 聊天记录(会话多选/时间范围/格式)
 * cs:export:business(wxid, folder) → 本地业务数据 JSON 归档(脱敏)
 * cs:export:openFolder(path) → 打开资源管理器
 * 进度推送事件:cs:export:progress
 */

export function registerExportHandlers(): void {
  const sendProgress = (evt: ProgressEvent): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('cs:export:progress', evt)
    }
  }

  ipcMain.handle('cs:export:chat', async (_e, wxid: string, opts: ChatExportOptions) => {
    if (!wxid) return { ok: false as const, error: '未连接微信账号' }
    return exportChat(wxid, opts || {}, sendProgress)
  })

  ipcMain.handle('cs:export:business', async (_e, wxid: string, folder: string) => {
    if (!wxid) return { ok: false as const, error: '未连接微信账号' }
    return exportBusiness(wxid, folder || '', sendProgress)
  })

  ipcMain.handle('cs:export:openFolder', async (_e, folder: string) => {
    if (!folder) return { ok: false as const, error: '缺少路径' }
    try {
      const error = await shell.openPath(folder)
      return error ? { ok: false as const, error } : { ok: true as const }
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  })

  // 通用写文件(监控快照等页面生成的内容落盘);文件名安全清洗防路径穿越
  ipcMain.handle('cs:export:writeFile', (_e, folder: string, name: string, content: string) => {
    if (!folder || typeof name !== 'string' || !name.trim()) {
      return { ok: false as const, error: '缺少参数' }
    }
    const safe = name.replace(/[\\/:*?"<>|\r\n\t]+/g, '_').slice(0, 120)
    if (!safe) return { ok: false as const, error: '文件名非法' }
    try {
      if (!existsSync(folder)) mkdirSync(folder, { recursive: true })
      const file = join(folder, safe)
      writeFileSync(file, String(content ?? ''), 'utf-8')
      return { ok: true as const, path: file }
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  })
}
