/**
 * 分享链接真实解析: 链接/口令 → 结构化素材(标题/正文/作者/图集/视频直链)。
 * 解析内核: vendor/ 目录(douyin.js / xhs.js, 移植自 parse.shenzjd.com)。
 * 合规边界: 游客态访问平台公开分享页的低频个人解析; 批量/商用请走官方或数据服务商。
 */

import parseDouyin from './vendor/douyin.js'
import parseXhs from './vendor/xhs.js'

export type ResolvedPlatform = 'douyin' | 'xhs'
export type ResolvedKind = 'image_text' | 'video'

/** 归一化后的解析结果(与 growth_content 入库字段对齐) */
export interface ResolvedShare {
  platform: ResolvedPlatform
  /** 平台内容 ID(短链未展开时可能为空, 去重走链接摘要) */
  platformItemId: string
  kind: ResolvedKind
  title: string
  desc: string
  authorName: string
  authorId: string
  link: string
  publishedAt: number | null
  likes: number
  collects: number
  comments: number
  shares: number
  coverUrl: string
  imageUrls: string[]
  videoUrl: string
  extra: Record<string, unknown>
}

/** 用户可读的解析失败(文案直接展示在界面) */
export class ResolveError extends Error {}

const URL_RE = /https?:\/\/[^\s"'<>()]+/i

const PATTERNS = {
  douyin: /v\.douyin\.com|douyin\.com|iesdouyin\.com/i,
  xhs: /xiaohongshu\.com|xhslink\.(com|cn)/i
} as const

interface VendorResp {
  code?: number
  msg?: string
  data?: Record<string, unknown> | null
}

/** 从解析器返回的 d.stats 中取值(旧版解析器无 stats 时回退 0) */
function statsNum(d: Record<string, unknown>, key: string): number {
  const st = d.stats
  if (st && typeof st === 'object') {
    const v = (st as Record<string, unknown>)[key]
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
  }
  return 0
}

function cleanImageList(list: unknown, cover: unknown): string[] {
  const raw = Array.isArray(list) ? list : []
  const out: string[] = []
  const push = (u: unknown): void => {
    if (typeof u !== 'string' || !/^https?:\/\//.test(u)) return
    if (!out.includes(u)) out.push(u)
  }
  push(cover)
  for (const item of raw) push(item)
  return out.slice(0, 20)
}

function normDouyin(res: VendorResp): ResolvedShare {
  const d = (res.data ?? {}) as Record<string, unknown>
  const images = cleanImageList(d.images, d.cover)
  return {
    platform: 'douyin',
    platformItemId: typeof d.awemeId === 'string' ? d.awemeId : '',
    kind: d.type === 'video' ? 'video' : 'image_text',
    title: typeof d.title === 'string' ? d.title : '',
    desc: typeof d.desc === 'string' ? d.desc : '',
    authorName: typeof d.author === 'string' ? d.author : '',
    authorId: typeof d.uid === 'string' ? d.uid : '',
    link: '',
    publishedAt: typeof d.time === 'number' && d.time > 0 ? d.time * 1000 : null,
    likes: typeof d.like === 'number' ? d.like : 0,
    collects: statsNum(d, 'collects'),
    comments: statsNum(d, 'comments'),
    shares: statsNum(d, 'shares'),
    coverUrl: images[0] ?? '',
    imageUrls: images,
    videoUrl: typeof d.url === 'string' ? d.url : '',
    extra: {
      resolver: 'share-parse-v1',
      audioUrl: typeof d.audioUrl === 'string' ? d.audioUrl : '',
      music: d.music ?? null,
      avatar: typeof d.avatar === 'string' ? d.avatar : ''
    }
  }
}

function normXhs(res: VendorResp): ResolvedShare {
  const d = (res.data ?? {}) as Record<string, unknown>
  const images = cleanImageList(d.images, d.cover)
  return {
    platform: 'xhs',
    platformItemId: typeof d.noteId === 'string' ? d.noteId : '',
    kind: typeof d.url === 'string' && d.url ? 'video' : 'image_text',
    title: typeof d.title === 'string' ? d.title : '',
    desc: typeof d.desc === 'string' ? d.desc : typeof d.title === 'string' ? d.title : '',
    authorName: typeof d.author === 'string' ? d.author : '',
    authorId: typeof d.authorID === 'string' ? d.authorID : '',
    link: '',
    publishedAt: null,
    likes: statsNum(d, 'likes'),
    collects: statsNum(d, 'collects'),
    comments: statsNum(d, 'comments'),
    shares: statsNum(d, 'shares'),
    coverUrl: images[0] ?? '',
    imageUrls: images,
    videoUrl: typeof d.url === 'string' ? d.url : '',
    extra: {
      resolver: 'share-parse-v1',
      avatar: typeof d.avatar === 'string' ? d.avatar : ''
    }
  }
}

function assertOk(
  res: VendorResp,
  platform: string
): asserts res is VendorResp & { code: 200; data: Record<string, unknown> } {
  if (!res || res.code !== 200 || !res.data) {
    const msg = res?.msg || '解析失败(平台未返回可读原因)'
    throw new ResolveError(
      platform === 'douyin' ? '抖音解析失败: ' + msg : '小红书解析失败: ' + msg
    )
  }
}

/**
 * 解析分享文本(支持完整链接与含链接的口令)。
 * 真实分享多为「口令文字 + 短链」混合文本: 先抽取首个 http(s) URL 再交给平台解析器,
 * 取不到 URL 时保留原文, 由平台侧给出明确错误。
 * 失败抛 ResolveError(文案面向用户), 网络异常抛普通 Error。
 */
function extractFirstUrl(text: string): string {
  const hit = URL_RE.exec(text)
  return hit ? hit[0] : text
}

export async function resolveShareText(text: string): Promise<ResolvedShare> {
  const trimmed = (text ?? '').trim()
  if (!trimmed) throw new ResolveError('请粘贴小红书/抖音分享链接或口令')
  const feed = extractFirstUrl(trimmed)
  const platform = PATTERNS.douyin.test(feed)
    ? ('douyin' as const)
    : PATTERNS.xhs.test(feed)
      ? ('xhs' as const)
      : null
  if (!platform) {
    throw new ResolveError(
      '未能识别链接平台: 请粘贴完整的小红书(xiaohongshu/xhslink)或抖音(v.douyin/douyin.com)分享链接'
    )
  }

  const resp = platform === 'douyin' ? await parseDouyin(feed) : await parseXhs(feed)
  assertOk(resp as VendorResp, platform)
  const out = platform === 'douyin' ? normDouyin(resp as VendorResp) : normXhs(resp as VendorResp)

  // link: 抽取出的 URL(供去重与追溯)
  out.link = feed.startsWith('http') ? feed : feed.slice(0, 300)
  return out
}
