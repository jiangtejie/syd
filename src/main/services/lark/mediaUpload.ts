import { createReadStream, statSync } from 'node:fs'
import { extname } from 'node:path'
import { isBetterTier, tierLabel, type ImageTier } from '../../../shared/imageTier'
import { getMediaRef, saveMediaRef } from '../../db/repos/larkMediaRepo'
import { decryptImage, decryptVideo } from '../media/mediaService'
import { resolveMediaUrl } from '../report/mediaArchive'
import { larkUploadMedia } from './client'
import { createLogger } from '../logging'
import {
  decideEvidenceMedia,
  evidenceMediaName,
  maxMediaBytesOfKind,
  md5Of,
  mediaParentTypeOf,
  mediaSkipText,
  type EvidenceMediaKind,
  type EvidenceMediaSkipReason
} from './evidenceMedia'

const mediaLog = createLogger('lark')

/**
 * 证据媒体（图片 / 视频）→ 飞书素材 → Base 附件列的 file_token。
 *
 * 三步：① 本地准备文件（图片走解密、视频按 md5 定位明文 mp4）② 上传素材（drive upload_all，
 * 图片 parent_type=bitable_image、视频=bitable_file）③ 把 file_token 记进 lark_media_map，
 * 同一份媒体在别的议题里出现时直接复用。
 *
 * 图片一律按 **best**（高清原图 → 默认图 → 缩略图）解密。收益主要在两头（本机实测）：
 * ① 有 24% 的图默认图是纯 HEVC(wxgf)、高清那档才是普通 JPEG/PNG（体积中位 3.5 倍、最大 61 倍）；
 * ② 本机 48% 的默认图是纯 HEVC 而 **ffmpeg 未配置就解不出来**，旧顺序（orig 优先）对这批只能退回缩略图。
 * 注意：另有 76% 的高清档与默认图逐字节相同 —— 优先取高清不会更差，只是这部分没有增益。
 * 档位随 token 一起记进 lark_media_map：缓存里那份是缩略图/默认图时，下一轮拿到更好的档会重传；
 * 手里的那份不比缓存好就继续复用，不重复上传。附件名与日志都带上档位，降级不再静默。
 *
 * 失败一律「不致命」：证据行已经写进去了，附件传不上去只是这一列空着 —— 调用方按 failed 计数，
 * 下一轮还会重试（只有拿到 token 的记录才会被标记为已写）。
 *
 * 文件证据（file）目前只登记 md5/文件名，不上传：本地文件附件解析未做，不做半成品。
 */
export interface UploadEvidenceMediaResult {
  ok: boolean
  /** 拿到 token(含缓存命中) */
  fileToken?: string
  /** true = 复用已上传的素材,没有走网络 */
  cached?: boolean
  bytes?: number
  /** 图片实际用到的档位（高清原图/默认图/缩略图）；视频没有档位概念时为 undefined */
  tier?: ImageTier
  skipped?: EvidenceMediaSkipReason
  error?: string
}

export async function uploadEvidenceMedia(opts: {
  appToken: string
  /** 证据所属账号(取本地文件要按账号找密钥与附件目录) */
  accountWxid: string
  kind: EvidenceMediaKind
  /** 与 kind 对应的 md5（图片 imageMd5 / 视频 videoMd5） */
  md5: string
  /** 单文件上限(MB)；不传按类型默认（图片 10MB、视频 50MB） */
  maxMediaMB?: number
}): Promise<UploadEvidenceMediaResult> {
  const maxBytes = maxMediaBytesOfKind(opts.kind, opts.maxMediaMB)
  const md5 = md5Of(opts.md5)
  const ref = md5 ? getMediaRef(md5) : null
  // 缓存里已经是最高档（图片=高清原图 / 视频无档位概念）→ 直接复用，连本地扫描都省掉
  if (ref?.fileToken && (opts.kind !== 'image' || ref.tier === 'hd')) {
    return { ok: true, fileToken: ref.fileToken, cached: true, bytes: ref.size, tier: ref.tier }
  }
  const decision = decideEvidenceMedia({ kind: opts.kind, md5: opts.md5, maxBytes })
  if (decision.action === 'skip') {
    return { ok: false, skipped: decision.reason, error: mediaSkipText(decision.reason) }
  }

  // ① 本地准备文件（图片 best：高清原图 → 默认图 → 缩略图；命中缓存目录时不会重新解密/拷贝）
  let tier: ImageTier | undefined
  let local: { ok: boolean; url?: string; error?: string }
  if (opts.kind === 'video') {
    local = await decryptVideo({ wxid: opts.accountWxid, videoMd5: decision.md5 })
  } else {
    const img = await decryptImage({ wxid: opts.accountWxid, imageMd5: decision.md5, kind: 'best' })
    local = img
    // 拿不到 foundKind（理论不会发生）时按最保守的「默认图」记，不吹成高清
    tier = img.foundKind ?? 'orig'
  }
  if (!local.ok || !local.url) {
    // 本地这份拿不到，但历史 token 还在 → 降级复用，别让 Base 里的图凭空变空
    if (ref?.fileToken) {
      return { ok: true, fileToken: ref.fileToken, cached: true, bytes: ref.size, tier: ref.tier }
    }
    return {
      ok: false,
      error: local.error ?? (opts.kind === 'video' ? '视频未落地' : '图片解密失败')
    }
  }
  if (tier && tier !== 'hd') {
    mediaLog.info(
      `证据图片用${tierLabel(tier)}(${decision.md5}): 高清原图要在微信里点开「查看原图」才落地，下一轮会自动升级`
    )
  }
  // 手里这份不比缓存里那份好 → 复用旧 token，不重复上传
  if (ref?.fileToken && !isBetterTier(tier, ref.tier)) {
    return { ok: true, fileToken: ref.fileToken, cached: true, bytes: ref.size, tier: ref.tier }
  }
  const hit = resolveMediaUrl(local.url)
  if (!hit) return { ok: false, error: '本地缓存路径解析失败(ct-media 路径解析失败)' }

  let size = 0
  try {
    size = statSync(hit.abs).size
  } catch {
    return { ok: false, error: '读取本地媒体文件失败' }
  }
  const sized = decideEvidenceMedia({
    kind: opts.kind,
    md5: decision.md5,
    maxBytes,
    sizeBytes: size
  })
  if (sized.action === 'skip') {
    return { ok: false, skipped: sized.reason, bytes: size, error: mediaSkipText(sized.reason) }
  }

  // ② 上传素材(父节点=Base app_token)
  const fileName = evidenceMediaName(decision.md5, extname(hit.abs).slice(1), opts.kind, tier)
  const up = await larkUploadMedia({
    file_name: fileName,
    parent_type: mediaParentTypeOf(opts.kind),
    parent_node: opts.appToken,
    size,
    file: createReadStream(hit.abs)
  })
  if (!up.ok) {
    mediaLog.warn(
      `证据${opts.kind === 'video' ? '视频' : '图片'}上传失败(${fileName}): ${up.error}`
    )
    return { ok: false, error: up.error, bytes: size }
  }
  const token = up.fileToken

  // ③ 记住 token（含档位）:同一份媒体再出现时直接复用，档位更高的那份到了才会重传
  saveMediaRef({ md5: decision.md5, fileToken: token, fileName, size, tier })
  return { ok: true, fileToken: token, cached: false, bytes: size, tier }
}
