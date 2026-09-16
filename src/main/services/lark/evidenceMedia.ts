/**
 * 证据附件上传的纯逻辑：要不要传 / 用什么名字 / 传成哪种素材 / 上限多少。
 *
 * 为什么单独拆出来：附件这块最典型的故障是**静默失败** —— 图没传上去，Base 里只剩一个
 * 「[图片]」占位文本，同事以为本来就没图。把判定固化成纯函数后，自检里能直接断言
 * 「太大就跳」「md5 非法就跳」「已传过就复用 token」这些分支。
 *
 * 覆盖类型：**图片 + 视频**（微信 4.x 视频落地即明文 mp4，按 md5 定位即可上传）；
 * 文件证据目前只登记 md5/文件名，不上传附件（本地文件附件解析未做，见 skip 原因 file-unsupported）。
 */

import type { ImageTier } from '../../../shared/imageTier'

/** 证据附件的类型（决定 parent_type 与单文件上限） */
export type EvidenceMediaKind = 'image' | 'video' | 'file'

/** 飞书「上传素材」父类型：图片用 bitable_image，视频/文件用 bitable_file */
export const EVIDENCE_MEDIA_PARENT_TYPE = 'bitable_image'
export const EVIDENCE_FILE_PARENT_TYPE = 'bitable_file'

export function mediaParentTypeOf(kind: EvidenceMediaKind): string {
  return kind === 'image' ? EVIDENCE_MEDIA_PARENT_TYPE : EVIDENCE_FILE_PARENT_TYPE
}

/** 单张图片默认上限(MB)。飞书 upload_all 单次上限 20MB，留出余量 */
export const DEFAULT_MAX_MEDIA_MB = 10
/** 视频默认上限(MB)：一段几十秒的门店视频通常 5~30MB */
export const DEFAULT_MAX_VIDEO_MB = 50
/** 单轮最多上传几个（限流闸门，避免一轮打几百个 multipart） */
export const DEFAULT_MAX_UPLOADS_PER_ROUND = 20

export interface EvidenceMediaInput {
  /** evidenceMediaKind() 的结论；null = 这行没有可上传的媒体 */
  kind: EvidenceMediaKind | null
  /** 与 kind 对应的 md5 */
  md5?: string
  /** md5 → file_token 缓存命中时的 token */
  cachedToken?: string
  /** 本地准备后的文件大小(字节)；未知传 undefined，由调用方 stat 后再判 */
  sizeBytes?: number
  /** 单文件上限(字节) */
  maxBytes: number
}

export type EvidenceMediaSkipReason = 'not-media' | 'no-md5' | 'too-big' | 'file-unsupported'

export type EvidenceMediaDecision =
  | { action: 'attach'; md5: string }
  | { action: 'cached'; md5: string; fileToken: string }
  | { action: 'skip'; reason: EvidenceMediaSkipReason }

/** 该证据行属于哪种可上传类型；都不是 → null（仍写占位文本） */
export function evidenceMediaKind(
  localType: number | undefined,
  md5s: { imageMd5?: string; videoMd5?: string; fileMd5?: string } = {}
): EvidenceMediaKind | null {
  if (Number(localType) === 3 || !!md5Of(md5s.imageMd5)) return 'image'
  if (Number(localType) === 43 || !!md5Of(md5s.videoMd5)) return 'video'
  if (md5Of(md5s.fileMd5)) return 'file'
  return null
}

/** 该行取哪种类型的 md5（与 evidenceMediaKind 对应） */
export function evidenceMediaMd5Of(
  kind: EvidenceMediaKind,
  md5s: { imageMd5?: string; videoMd5?: string; fileMd5?: string }
): string | null {
  if (kind === 'image') return md5Of(md5s.imageMd5)
  if (kind === 'video') return md5Of(md5s.videoMd5)
  return md5Of(md5s.fileMd5)
}

/** 该证据行是不是「可上传的图片」：local_type=3 或带了合法 image_md5 */
export function isEvidenceImage(localType: number | undefined, imageMd5?: string): boolean {
  return evidenceMediaKind(localType, { imageMd5 }) === 'image'
}

/** 校验并归一化 md5(32 位十六进制,小写);不合法返回 null */
export function md5Of(value?: string): string | null {
  const md5 = (value ?? '').trim().toLowerCase()
  return /^[0-9a-f]{32}$/.test(md5) ? md5 : null
}

/** 兼容旧名（图片口径） */
export const imageMd5Of = md5Of

/**
 * 上传决策：缓存命中优先（同一张图/同一段视频在多个议题里出现时只传一次）。
 * 文件证据目前只登记不上传 → file-unsupported（不做半成品解析）。
 */
export function decideEvidenceMedia(input: EvidenceMediaInput): EvidenceMediaDecision {
  if (!input.kind) return { action: 'skip', reason: 'not-media' }
  if (input.kind === 'file') return { action: 'skip', reason: 'file-unsupported' }
  const md5 = md5Of(input.md5)
  if (!md5) return { action: 'skip', reason: 'no-md5' }
  const cached = (input.cachedToken ?? '').trim()
  if (cached) return { action: 'cached', md5, fileToken: cached }
  const size = input.sizeBytes
  if (typeof size === 'number' && Number.isFinite(size) && size > input.maxBytes) {
    return { action: 'skip', reason: 'too-big' }
  }
  return { action: 'attach', md5 }
}

/** 单文件上限(字节) → 从 MB 配置换算并夹住上限（图片 ≤20MB，视频 ≤200MB） */
export function maxMediaBytesOfKind(kind: EvidenceMediaKind, maxMediaMB?: number): number {
  if (kind === 'video') {
    const mb = Number.isFinite(Number(maxMediaMB)) ? Number(maxMediaMB) : DEFAULT_MAX_VIDEO_MB
    return Math.round(Math.min(Math.max(mb, 1), 200) * 1024 * 1024)
  }
  return maxMediaBytesOf(maxMediaMB)
}

/** 单张上限(字节) → 从 MB 配置换算,夹在 1~20MB */
export function maxMediaBytesOf(maxMediaMB: number | undefined): number {
  const mb = Number.isFinite(Number(maxMediaMB)) ? Number(maxMediaMB) : DEFAULT_MAX_MEDIA_MB
  const clamped = Math.min(Math.max(mb, 1), 20)
  return Math.round(clamped * 1024 * 1024)
}

/**
 * 上传到 Base 的文件名：用 md5 前缀，不带任何客户信息（文件名会显示在附件卡片上）。
 * 保留扩展名，Base 预览靠它决定渲染方式。
 *
 * tier 已知时带上档位后缀（image_<md5:8>_hd.jpg）：同事在 Base 里一眼能看出这张是高清原图，
 * 还是本机只落到了默认图/缩略图（高清要在微信里点开「查看原图」才有）——
 * 以前两种情况同名，只有点开对比才发现「证据图怎么这么糊」。
 */
export function evidenceMediaName(
  md5: string,
  ext: string,
  kind: EvidenceMediaKind = 'image',
  tier?: ImageTier | null
): string {
  const clean = ext.replace(/[^a-z0-9]/gi, '').toLowerCase() || (kind === 'video' ? 'mp4' : 'jpg')
  const base = kind + '_' + md5.slice(0, 8)
  return tier ? `${base}_${tier}.${clean}` : `${base}.${clean}`
}

/** 附件字段的写入值：飞书要求 [{file_token}] */
export function attachmentFieldValue(fileToken: string): Array<{ file_token: string }> {
  return [{ file_token: fileToken }]
}

/** 人类可读的跳过原因（设置页/日志用） */
export function mediaSkipText(reason: EvidenceMediaSkipReason): string {
  switch (reason) {
    case 'not-media':
      return '非图片/视频证据(不传附件)'
    case 'no-md5':
      return '缺少有效 md5'
    case 'file-unsupported':
      return '文件证据暂不支持上传（仅登记 md5 与文件名）'
    default:
      return '超过单文件上限'
  }
}
