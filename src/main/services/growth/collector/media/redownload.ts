/**
 * 缺失图片重下载: 校验素材本地资产文件是否存在, 缺失则按源链接重新下载并重建资产记录。
 * 场景: 缓存被清理 / 早期目录 bug 导致 DB 有记录而文件丢失。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getGrowthMediaDir } from '../../../paths'
import { deleteAssetRows, getContentDetail, insertAsset } from '../../../../db/repos/growthRepo'
import { downloadMediaAssets } from './assetStore'

export interface RedownloadResult {
  ok: boolean
  added?: number
  failed?: number
  error?: string
}

export async function redownloadMissingMedia(contentId: number): Promise<RedownloadResult> {
  const detail = getContentDetail(contentId)
  if (!detail) return { ok: false, error: '素材不存在' }

  const extra = detail.extra as { remoteMedia?: { imageUrls?: string[]; coverUrl?: string } }
  const remote = extra.remoteMedia ?? {}
  const urls = (remote.imageUrls && remote.imageUrls.length > 0 ? remote.imageUrls : remote.coverUrl ? [remote.coverUrl] : []).filter(
    (u) => typeof u === 'string' && u.startsWith('http')
  )
  if (urls.length === 0) return { ok: false, error: '该素材没有可重新下载的图片源(可能是本地导入或纯视频)' }

  const base = getGrowthMediaDir()
  const local = detail.assets.filter((a) => a.kind === 'cover' || a.kind === 'image')
  const missing = local.filter((a) => !a.relPath || !existsSync(join(base, a.relPath)))

  // 全部缺失(或本地无记录)时重建整组; 部分缺失只补下载
  const needFull = local.length === 0 || missing.length === local.length
  if (needFull) deleteAssetRows(contentId, ['cover', 'image'])

  const media = await downloadMediaAssets(urls, detail.origin, 12)
  const startKind: 'cover' | 'image' = needFull ? 'cover' : 'image'
  let added = 0
  media.ok.forEach((m, i) => {
    insertAsset({
      contentId,
      kind: i === 0 && needFull ? startKind : m.kind,
      mime: m.mime,
      size: m.size,
      relPath: m.relPath,
      sourceMark: detail.origin + ':redownload'
    })
    added += 1
  })
  return { ok: added > 0, added, failed: media.failed.length, error: added > 0 ? undefined : '重新下载失败(源图可能已失效)' }
}
