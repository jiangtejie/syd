import { createReadStream, statSync } from 'node:fs'
import { extname } from 'node:path'
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
  const decision = decideEvidenceMedia({
    kind: opts.kind,
    md5: opts.md5,
    cachedToken: ref?.fileToken,
    maxBytes
  })
  if (decision.action === 'skip') {
    return { ok: false, skipped: decision.reason, error: mediaSkipText(decision.reason) }
  }
  if (decision.action === 'cached') {
    return { ok: true, fileToken: decision.fileToken, cached: true, bytes: ref?.size }
  }

  // ① 本地准备文件（命中缓存目录时不会重新解密/拷贝）
  const local =
    opts.kind === 'video'
      ? await decryptVideo({ wxid: opts.accountWxid, videoMd5: decision.md5 })
      : await decryptImage({ wxid: opts.accountWxid, imageMd5: decision.md5, kind: 'orig' })
  if (!local.ok || !local.url) {
    return {
      ok: false,
      error: local.error ?? (opts.kind === 'video' ? '视频未落地' : '图片解密失败')
    }
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
  const fileName = evidenceMediaName(decision.md5, extname(hit.abs).slice(1), opts.kind)
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

  // ③ 记住 token:同一份媒体再出现时不再上传
  saveMediaRef({ md5: decision.md5, fileToken: token, fileName, size })
  return { ok: true, fileToken: token, cached: false, bytes: size }
}
