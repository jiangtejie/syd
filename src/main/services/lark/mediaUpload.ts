import { createReadStream, statSync } from 'node:fs'
import { extname } from 'node:path'
import { getMediaRef, saveMediaRef } from '../../db/repos/larkMediaRepo'
import { decryptImage } from '../media/mediaService'
import { resolveMediaUrl } from '../report/mediaArchive'
import { larkUploadMedia } from './client'
import { createLogger } from '../logging'
import {
  EVIDENCE_MEDIA_PARENT_TYPE,
  decideEvidenceMedia,
  evidenceMediaName,
  imageMd5Of,
  maxMediaBytesOf,
  mediaSkipText,
  type EvidenceMediaSkipReason
} from './evidenceMedia'

const mediaLog = createLogger('lark')

/**
 * 证据图片 → 飞书素材 → Base 附件列的 file_token。
 *
 * 三步:① 本地解密出图(复用监控页看图那条链路,不另做解密)② 上传素材(drive upload_all)
 * ③ 把 file_token 记进 lark_media_map,同一张图在别的议题里出现时直接复用,不重复上传。
 *
 * 失败一律「不致命」:证据行已经写进去了,附件传不上去只是这一列空着 —— 调用方按 failed 计数,
 * 下一轮还会重试(只有拿到 token 的记录才会被标记为已写)。
 */
export interface UploadEvidenceImageResult {
  ok: boolean
  /** 拿到 token(含缓存命中) */
  fileToken?: string
  /** true = 复用已上传的素材,没有走网络 */
  cached?: boolean
  bytes?: number
  skipped?: EvidenceMediaSkipReason
  error?: string
}

export async function uploadEvidenceImage(opts: {
  appToken: string
  /** 证据所属账号(解密要按账号读密钥与附件目录) */
  accountWxid: string
  localType?: number
  imageMd5?: string
  /** 单张上限(MB),默认 10 */
  maxMediaMB?: number
}): Promise<UploadEvidenceImageResult> {
  const maxBytes = maxMediaBytesOf(opts.maxMediaMB)
  const md5 = imageMd5Of(opts.imageMd5)
  const ref = md5 ? getMediaRef(md5) : null
  const decision = decideEvidenceMedia({
    localType: opts.localType,
    imageMd5: opts.imageMd5,
    cachedToken: ref?.fileToken,
    maxBytes
  })
  if (decision.action === 'skip') {
    return { ok: false, skipped: decision.reason, error: mediaSkipText(decision.reason) }
  }
  if (decision.action === 'cached') {
    return { ok: true, fileToken: decision.fileToken, cached: true, bytes: ref?.size }
  }

  // ① 本地解密(命中缓存目录时不会再解密一次)
  const dec = await decryptImage({ wxid: opts.accountWxid, imageMd5: decision.md5, kind: 'orig' })
  if (!dec.ok || !dec.url) return { ok: false, error: dec.error ?? '图片解密失败' }
  const hit = resolveMediaUrl(dec.url)
  if (!hit) return { ok: false, error: '解密产物不在缓存目录(ct-media 路径解析失败)' }

  let size = 0
  try {
    size = statSync(hit.abs).size
  } catch {
    return { ok: false, error: '读取本地图片文件失败' }
  }
  const sized = decideEvidenceMedia({
    localType: opts.localType,
    imageMd5: opts.imageMd5,
    maxBytes,
    sizeBytes: size
  })
  if (sized.action === 'skip') {
    return { ok: false, skipped: sized.reason, bytes: size, error: mediaSkipText(sized.reason) }
  }

  // ② 上传素材(父节点=Base app_token,父类型=多维表格图片)
  const fileName = evidenceMediaName(decision.md5, extname(hit.abs).slice(1))
  const up = await larkUploadMedia({
    file_name: fileName,
    parent_type: EVIDENCE_MEDIA_PARENT_TYPE,
    parent_node: opts.appToken,
    size,
    file: createReadStream(hit.abs)
  })
  if (!up.ok) {
    mediaLog.warn(`证据图片上传失败(${fileName}): ${up.error}`)
    return { ok: false, error: up.error, bytes: size }
  }
  const token = up.fileToken

  // ③ 记住 token:同一张图再出现时不再上传
  saveMediaRef({ md5: decision.md5, fileToken: token, fileName, size })
  return { ok: true, fileToken: token, cached: false, bytes: size }
}
