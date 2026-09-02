import { ipcMain } from 'electron'
import { decryptImage, decryptVideo, testImageDecrypt } from '../services/media/mediaService'
import type { DecryptImageOptions, DecryptVideoOptions } from '../services/media/mediaService'

/** 图片/视频 .dat 解密 IPC（M3）：渲染进程传 wxid + md5 → 返回可访问的 ct-media:// URL */
export function registerMediaHandlers(): void {
  ipcMain.handle('cs:media:decryptImage', (_e, opts: DecryptImageOptions) => {
    try {
      return decryptImage(opts || {})
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('cs:media:decryptVideo', (_e, opts: DecryptVideoOptions) => {
    try {
      return decryptVideo(opts || {})
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
