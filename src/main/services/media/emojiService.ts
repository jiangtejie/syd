import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getMediaCacheDir } from '../paths'

/**
 * 动画/商店表情本地化（移植 CipherTalk emoji.ts 的 CDN/模板 URL 链，裁剪本地加密缓存解密链路）。
 * 解析出的消息表情只有短时效 cdnUrl：这里统一缓存到 <cache>/media/<wxid>/<md5>_emoji.<ext>
 * （ct-media 协议可加载），过期裂图后可复用；商店表情（com.tencent.xin.emoticon.*）无 cdnUrl
 * 时按 md5 拼接微信表情资源 CDN 模板下载。全程静默失败 → 渲染端回落文本摘要。
 */

const EMOJI_EXTS = ['gif', 'webp', 'png', 'jpg', 'jpeg'] as const
const DOWNLOAD_TIMEOUT_MS = 10_000
const MAX_BYTES = 8 * 1024 * 1024
const STORE_PREFIX = 'com.tencent.xin.emoticon.'
const STORE_BASE_URLS = [
  'https://emoji.weixin.qq.com/resource/emoticon',
  'https://emoji.qpic.cn/resource/emoticon',
  'https://mmbiz.qpic.cn/mmemoticon'
]

/** 嗅探图片扩展名（与 CipherTalk detectImageExtension 一致） */
function sniffImageExt(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg'
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50) return 'png'
  if (buf.length >= 6 && buf.toString('latin1', 0, 6) === 'GIF89a') return 'gif'
  if (
    buf.length >= 12 &&
    buf.toString('latin1', 0, 4) === 'RIFF' &&
    buf.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'webp'
  }
  return null
}

/** 找已缓存文件：media/<wxid>/<md5>_emoji.<ext> */
function findCachedEmoji(wxid: string, md5Lower: string): string | null {
  try {
    const dir = getMediaCacheDir(wxid)
    if (!existsSync(dir)) return null
    const prefix = `${md5Lower}_emoji.`
    for (const name of readdirSync(dir)) {
      if (name.startsWith(prefix) && EMOJI_EXTS.some((e) => name.endsWith('.' + e))) {
        return `ct-media://media/${encodeURIComponent(wxid)}/${encodeURIComponent(name)}`
      }
    }
  } catch {
    /* 目录不可读等，按无缓存处理 */
  }
  return null
}

async function fetchBuf(url: string): Promise<Buffer | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: ctrl.signal
    })
    if (!res.ok) return null
    const arr = new Uint8Array(await res.arrayBuffer())
    return arr.length > 0 && arr.length <= MAX_BYTES ? Buffer.from(arr) : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 下载并缓存表情：校验 md5（与消息一致才落缓存）→ 写 media/<wxid>/<md5>_emoji.<ext>。
 * 返回本地 ct-media URL；全部失败返回 null。
 */
async function downloadToCache(
  wxid: string,
  md5Lower: string,
  candidates: string[]
): Promise<string | null> {
  for (const url of candidates) {
    if (!/^https?:\/\//i.test(url)) continue
    const buf = await fetchBuf(url)
    if (!buf) continue
    const ext = sniffImageExt(buf)
    if (!ext) continue
    if (md5Lower) {
      const digest = createHash('md5').update(buf).digest('hex')
      if (digest !== md5Lower) continue // 内容与消息 md5 不符：跳过该源
    }
    try {
      const dir = getMediaCacheDir(wxid)
      mkdirSync(dir, { recursive: true })
      const name = `${md5Lower || `emoji-${Date.now().toString(36)}`}_emoji.${ext}`
      writeFileSync(join(dir, name), buf)
      return `ct-media://media/${encodeURIComponent(wxid)}/${encodeURIComponent(name)}`
    } catch {
      return null
    }
  }
  return null
}

export interface ResolveEmojiInput {
  md5?: string
  productId?: string
  cdnUrl?: string
}

export async function resolveEmojiLocal(
  wxid: string,
  input: ResolveEmojiInput
): Promise<{ ok: boolean; url?: string; error?: string }> {
  try {
    const md5Lower = (input.md5 || '').trim().toLowerCase()
    // 1) 已缓存
    if (md5Lower) {
      const cached = findCachedEmoji(wxid, md5Lower)
      if (cached) return { ok: true, url: cached }
    }
    // 2) 候选源：消息自带 cdnUrl → 商店表情模板
    const candidates: string[] = []
    if (input.cdnUrl && /^https?:\/\//i.test(input.cdnUrl.trim())) {
      candidates.push(input.cdnUrl.trim())
    }
    const productId = (input.productId || '').trim()
    if (productId.startsWith(STORE_PREFIX) && md5Lower) {
      const productPath = productId.slice(STORE_PREFIX.length)
      for (const base of STORE_BASE_URLS) {
        candidates.push(`${base}/${productPath}/${md5Lower}.gif`)
        candidates.push(`${base}/${productPath}/${md5Lower}.webp`)
        candidates.push(`${base}/${productPath}/${md5Lower}.png`)
      }
    }
    if (candidates.length === 0) return { ok: false }
    const local = await downloadToCache(wxid, md5Lower, candidates)
    if (local) return { ok: true, url: local }
    return { ok: false }
  } catch {
    return { ok: false }
  }
}
