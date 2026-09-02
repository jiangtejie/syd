import { ipcMain } from 'electron'
import { decryptImage, testImageDecrypt } from '../services/media/mediaService'
import type { DecryptImageOptions } from '../services/media/mediaService'

/** 图片 .dat 解密 IPC（M3）：渲染进程传 wxid + imageMd5 → 返回可访问的 ct-media:// URL */
export function registerMediaHandlers(): void {
  ipcMain.handle('cs:media:decryptImage', (_e, opts: DecryptImageOptions) => {
    try {
      return decryptImage(opts || {})
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('cs:media:testImageDecrypt', (_e, wxid: string, dbPath?: string) => {
    try {
      return testImageDecrypt(wxid, dbPath)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
