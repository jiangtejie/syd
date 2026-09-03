import { ipcMain } from 'electron'
import { decryptImage, decryptVideo, testImageDecrypt } from '../services/media/mediaService'
import type { DecryptImageOptions, DecryptVideoOptions } from '../services/media/mediaService'
import { resolveEmojiLocal, type ResolveEmojiInput } from '../services/media/emojiService'

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
  // 动画/商店表情本地化：cdn/模板 URL 下载缓存 → ct-media 本地地址（渲染端裂图后重试用）
  ipcMain.handle('cs:media:resolveEmoji', async (_e, wxid: string, input: ResolveEmojiInput) => {
    if (!wxid || typeof wxid !== 'string') return { ok: false as const, error: '缺少账号' }
    return resolveEmojiLocal(wxid, input || {})
  })
}
