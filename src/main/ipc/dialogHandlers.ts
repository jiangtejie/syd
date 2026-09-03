import { ipcMain, dialog, BrowserWindow } from 'electron'
import { dirname, isAbsolute } from 'path'
import { existsSync } from 'fs'

/**
 * 系统对话框 IPC（设置页用）。
 * cs:dialog:pickDirectory → 选择目录（微信数据根路径 / 数据缓存目录）。
 * defaultPath 指定对话框初始定位目录；目录不存在时向上回退到最近存在的上级目录。
 */
function resolveStartDir(defaultPath?: string): string | undefined {
  if (!defaultPath || !isAbsolute(defaultPath)) return undefined
  let cur = defaultPath
  for (;;) {
    if (existsSync(cur)) return cur
    const parent = dirname(cur)
    if (parent === cur) return undefined
    cur = parent
  }
}

export function registerDialogHandlers(): void {
  ipcMain.handle('cs:dialog:pickDirectory', async (e, title?: string, defaultPath?: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showOpenDialog(win!, {
      title: title ?? '选择目录',
      defaultPath: resolveStartDir(defaultPath),
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return { ok: false }
    return { ok: true, path: result.filePaths[0] }
  })
}
