import { ipcMain } from 'electron'
import {
  decryptImage,
  decryptVideo,
  ffmpegStatus,
  testImageDecrypt
} from '../services/media/mediaService'
import type { DecryptImageOptions, DecryptVideoOptions } from '../services/media/mediaService'
import { resolveEmojiLocal, type ResolveEmojiInput } from '../services/media/emojiService'
import { getVoiceWav } from '../services/media/voice'
import { getDecryptedKey, hasAnyKey } from '../services/keyStoreService'
import { asrTencentStatus, saveAsrSecretKey, transcribeVoice } from '../services/media/asrTencent'

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
  // ffmpeg 解析现状：设置页据此说清「随包已就绪，你不用填」还是「正在回退」
  ipcMain.handle('cs:media:ffmpegStatus', () => {
    try {
      return { ok: true, status: ffmpegStatus() }
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
  // 语音消息（localType 34）：VoiceInfo 取 SILK → silk-wasm 解码 → 缓存 WAV → ct-media URL
  // 密钥只在主进程内存里取，渲染端只拿 wxid + 定位字段
  ipcMain.handle(
    'cs:media:voiceWav',
    async (
      _e,
      wxid: string,
      opts?: { serverId?: string; localId?: number; createTime?: number }
    ) => {
      if (!wxid || typeof wxid !== 'string') return { ok: false as const, error: '缺少账号' }
      const hexKey = getDecryptedKey(wxid) || ''
      if (!hexKey && !hasAnyKey(wxid)) {
        return { ok: false as const, error: '未配置数据库密钥，请先在设置里导入' }
      }
      try {
        return await getVoiceWav({ wxid, hexKey, ...(opts || {}) })
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // 语音转写（腾讯云一句话识别）：SILK 直传，不走本地识别引擎
  ipcMain.handle(
    'cs:media:voiceTranscript',
    async (
      _e,
      wxid: string,
      opts?: { serverId?: string; localId?: number; createTime?: number; force?: boolean }
    ) => {
      if (!wxid || typeof wxid !== 'string') return { ok: false as const, error: '缺少账号' }
      try {
        return await transcribeVoice({ wxid, ...(opts || {}) })
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
  ipcMain.handle('cs:media:asrStatus', () => {
    try {
      return { ok: true as const, ...asrTencentStatus() }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })
  /** 保存腾讯云 SecretKey（主进程加密后落库，渲染端不持有明文） */
  ipcMain.handle('cs:media:asrSaveSecret', (_e, secretKey: string) => {
    try {
      return saveAsrSecretKey(secretKey)
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // 动画/商店表情本地化：cdn/模板 URL 下载缓存 → ct-media 本地地址（渲染端裂图后重试用）
  ipcMain.handle('cs:media:resolveEmoji', async (_e, wxid: string, input: ResolveEmojiInput) => {
    if (!wxid || typeof wxid !== 'string') return { ok: false as const, error: '缺少账号' }
    return resolveEmojiLocal(wxid, input || {})
  })
}
