/**
 * 素材媒体落盘: 把解析出的封面/图集下载到 <cache>/growth/media, 供 ct-growth:// 本地展示。
 * 反防盗链: 下载请求自带平台 Referer(与浏览器内嵌页一致), 失败不阻塞入库(仅记录)。
 */

import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getGrowthMediaDir } from '../../../paths'

const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

const MIME_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif'
}

const MAX_BYTES = 25 * 1024 * 1024
const TIMEOUT_MS = 12_000
const CONCURRENCY = 4

export interface StoredMedia {
  kind: 'cover' | 'image'
  /** 相对 <cache>/growth/media 的路径, 如 ab/<sha>.jpg */
  relPath: string
  mime: string
  size: number
}

export interface DownloadOutcome {
  ok: StoredMedia[]
  failed: string[]
}

function refererFor(platform: string): string {
  if (platform === 'xhs') return 'https://www.xiaohongshu.com/'
  if (platform === 'douyin') return 'https://www.douyin.com/'
  return ''
}

function extOf(url: string, mime: string): string {
  const fromMime = MIME_EXT[mime]
  if (fromMime) return fromMime
  const m = /\\.(jpe?g|png|webp|gif)(\?|$)/i.exec(url)
  if (!m) return ''
  const e = m[1].toLowerCase()
  return e === 'jpeg' ? '.jpg' : '.' + e
}

async function downloadOne(
  url: string,
  kind: 'cover' | 'image',
  referer: string
): Promise<StoredMedia | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA_DESKTOP,
        Referer: referer,
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
      }
    })
    if (!res.ok) return null
    const declared = Number(res.headers.get('content-length') || 0)
    if (declared > MAX_BYTES) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length === 0 || buf.length > MAX_BYTES) return null
    const mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    const ext = extOf(url, mime)
    if (!ext) return null
    const sha = createHash('sha1').update(buf).digest('hex')
    const sub = sha.slice(0, 2)
    const relPath = sub + '/' + sha + ext
    await mkdir(join(getGrowthMediaDir(), sub), { recursive: true })
    await writeFile(join(getGrowthMediaDir(), relPath), buf)
    return { kind, relPath, mime, size: buf.length }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 下载图集(首张按 cover 记录)到本地 growth/media。
 * @param imageUrls 已去重的 https 图片直链(首张视作封面)
 * @param platform xhs | douyin(决定 Referer)
 * @param maxCount 最多下载张数(默认 10)
 */
export async function downloadMediaAssets(
  imageUrls: string[],
  platform: string,
  maxCount = 10
): Promise<DownloadOutcome> {
  const list = imageUrls.filter((u) => /^https?:\/\//.test(u)).slice(0, maxCount)
  const referer = refererFor(platform)
  const ok: StoredMedia[] = []
  const failed: string[] = []
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < list.length) {
      const idx = cursor
      cursor += 1
      const url = list[idx]
      const stored = await downloadOne(url, idx === 0 ? 'cover' : 'image', referer)
      if (stored) ok.push(stored)
      else failed.push(url)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, () => worker()))
  ok.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'cover' ? -1 : 1))
  return { ok, failed }
}
