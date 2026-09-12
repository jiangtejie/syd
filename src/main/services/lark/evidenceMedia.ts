/**
 * 证据附件(图片)上传的纯逻辑:要不要传 / 用什么名字 / 传成哪种素材。
 *
 * 为什么单独拆出来:附件这块最典型的故障是**静默失败** —— 图没传上去,Base 里只剩一个
 * 「[图片]」占位文本,同事以为本来就没图。把判定固化成纯函数后,自检里能直接断言
 * 「太大就跳」「md5 非法就跳」「已传过就复用 token」这些分支。
 *
 * 边界(与数据模型对齐):本地证据表 issue_feedback_msg 只存 image_md5,视频/文件消息没有
 * 对应的 md5 列,所以一期只上传图片证据;其它类型仍写占位标记。
 */

/** 飞书云文档「上传素材」的父类型:多维表格附件用 bitable_image */
export const EVIDENCE_MEDIA_PARENT_TYPE = 'bitable_image'

/** 单张图片默认上限(MB)。飞书 upload_all 单次上限 20MB,留出余量 */
export const DEFAULT_MAX_MEDIA_MB = 10
/** 单轮最多上传几张(限流闸门,避免一轮打几百个 multipart) */
export const DEFAULT_MAX_UPLOADS_PER_ROUND = 20

export interface EvidenceMediaInput {
  localType?: number
  imageMd5?: string
  /** md5 → file_token 缓存命中时的 token */
  cachedToken?: string
  /** 本地解密后的文件大小(字节);未知传 undefined,由调用方 stat 后再判 */
  sizeBytes?: number
  /** 单张上限(字节) */
  maxBytes: number
}

export type EvidenceMediaSkipReason = 'not-image' | 'no-md5' | 'too-big'

export type EvidenceMediaDecision =
  | { action: 'attach'; md5: string }
  | { action: 'cached'; md5: string; fileToken: string }
  | { action: 'skip'; reason: EvidenceMediaSkipReason }

/** 该证据行是不是「可上传的图片」:local_type=3 或带了合法 image_md5 */
export function isEvidenceImage(localType: number | undefined, imageMd5?: string): boolean {
  return Number(localType) === 3 || !!imageMd5Of(imageMd5)
}

/** 校验并归一化图片 md5(32 位十六进制,小写);不合法返回 null */
export function imageMd5Of(imageMd5?: string): string | null {
  const md5 = (imageMd5 ?? '').trim().toLowerCase()
  return /^[0-9a-f]{32}$/.test(md5) ? md5 : null
}

/** 上传决策:缓存命中优先(同一张图在多个议题里出现时只传一次) */
export function decideEvidenceMedia(input: EvidenceMediaInput): EvidenceMediaDecision {
  const md5 = imageMd5Of(input.imageMd5)
  if (!isEvidenceImage(input.localType, input.imageMd5))
    return { action: 'skip', reason: 'not-image' }
  if (!md5) return { action: 'skip', reason: 'no-md5' }
  const cached = (input.cachedToken ?? '').trim()
  if (cached) return { action: 'cached', md5, fileToken: cached }
  const size = input.sizeBytes
  if (typeof size === 'number' && Number.isFinite(size) && size > input.maxBytes) {
    return { action: 'skip', reason: 'too-big' }
  }
  return { action: 'attach', md5 }
}

/** 单张上限(字节) → 从 MB 配置换算,夹在 1~20MB */
export function maxMediaBytesOf(maxMediaMB: number | undefined): number {
  const mb = Number.isFinite(Number(maxMediaMB)) ? Number(maxMediaMB) : DEFAULT_MAX_MEDIA_MB
  const clamped = Math.min(Math.max(mb, 1), 20)
  return Math.round(clamped * 1024 * 1024)
}

/**
 * 上传到 Base 的文件名:用 md5 前缀,不带任何客户信息(文件名会显示在附件卡片上)。
 * 保留扩展名,Base 预览靠它决定渲染方式。
 */
export function evidenceMediaName(md5: string, ext: string): string {
  const clean = ext.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'jpg'
  return `image_${md5.slice(0, 8)}.${clean}`
}

/** 附件字段的写入值:飞书要求 [{file_token}] */
export function attachmentFieldValue(fileToken: string): Array<{ file_token: string }> {
  return [{ file_token: fileToken }]
}

/** 人类可读的跳过原因(设置页/日志用) */
export function mediaSkipText(reason: EvidenceMediaSkipReason): string {
  switch (reason) {
    case 'not-image':
      return '非图片证据(不传附件)'
    case 'no-md5':
      return '缺少有效 image_md5'
    default:
      return '超过单张上限'
  }
}
