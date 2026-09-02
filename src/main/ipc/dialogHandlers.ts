import { ipcMain, dialog, BrowserWindow } from 'electron'

/**
 * 系统对话框 IPC（设置页用）。
 * cs:dialog:pickDirectory → 选择目录（微信数据根路径）
 */
export function registerDialogHandlers(): void {
  ipcMain.handle('cs:dialog:pickDirectory', async (e, title?: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showOpenDialog(win!, {
      title: title ?? '选择目录',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return { ok: false }
    return { ok: true, path: result.filePaths[0] }
  })
}
