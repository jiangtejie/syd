/**
 * 素材仓库服务: 链接真实解析入库(封面/图集落盘) / 查询 / 运营字段更新。
 * 解析失败时返回用户可读原因, 不建占位卡(避免误导)。
 */

import { resolveShareText, type ResolvedShare } from '../collector/resolver'
import { downloadMediaAssets } from '../collector/media/assetStore'
import { sha1Of } from '../_hash'
import { errText } from '../_errors'
import { getDb } from '../../../db/database'
import {
  getContentDetail,
  getContentItem,
  insertAsset,
  insertContent,
  listContents,
  updateContentFields
} from '../../../db/repos/growthRepo'
import type {
  GrowthContentDetail,
  GrowthContentFilter,
  GrowthContentItem,
  GrowthListResult
} from '../../../../shared/growth'

export interface IngestShareResult {
  ok: boolean
  item?: GrowthContentItem
  existed?: boolean
  error?: string
}

/**
 * 粘贴分享链接/口令 → 真实解析入库。
 * - 解析: vendor 内核(抖音分享页/小红书笔记), 提取标题/正文/作者/图集/视频直链;
 * - 媒体: 封面与图集图片下载到本地 growth/media(失败仅记入 note, 不阻塞入库);
 * - 视频文件不下载, 直链存入 extra.remoteMedia, Phase 1 下载/爆改时使用。
 */
export async function ingestShareText(text: string): Promise<IngestShareResult> {
  let resolved: ResolvedShare
  try {
    resolved = await resolveShareText(text)
  } catch (e) {
    return { ok: false, error: errText(e) }
  }

  const media = await downloadMediaAssets(
    resolved.imageUrls.length > 0
      ? resolved.imageUrls
      : resolved.coverUrl
        ? [resolved.coverUrl]
        : [],
    resolved.platform
  )

  const noteParts: string[] = []
  if (media.failed.length > 0) {
    noteParts.push('图片下载失败 ' + String(media.failed.length) + ' 张(可稍后重试或手动补全)')
  }
  if (!resolved.coverUrl && !resolved.videoUrl) {
    noteParts.push('未获取到媒体(可能需登录或内容已限制)')
  }
  const note = noteParts.join('; ')

  const title = resolved.title || (resolved.desc || '').slice(0, 80) || '(无标题内容)'
  const inserted = insertContent({
    // 去重键: 优先平台内容 ID(同一内容不同分享形式不重复), 无 ID 时回退链接摘要
    dedupeKey: resolved.platformItemId
      ? resolved.platform + ':item:' + resolved.platformItemId
      : resolved.platform + ':url:' + sha1Of(resolved.link || text),
    origin: resolved.platform,
    kind: resolved.kind,
    platformItemId: resolved.platformItemId,
    title,
    text: resolved.desc || resolved.title || '',
    authorName: resolved.authorName,
    authorId: resolved.authorId,
    link: resolved.link,
    publishedAt: resolved.publishedAt,
    tags: [],
    usage: 'ref',
    interactions: {
      likes: resolved.likes,
      collects: resolved.collects,
      comments: resolved.comments,
      shares: resolved.shares
    },
    note,
    extra: {
      remoteMedia: {
        coverUrl: resolved.coverUrl || '',
        imageUrls: resolved.imageUrls,
        videoUrl: resolved.videoUrl || '',
        audioUrl: (resolved.extra as { audioUrl?: string }).audioUrl || ''
      },
      resolver: (resolved.extra as { resolver?: string }).resolver || 'share-parse-v1',
      mediaSaved: media.ok.length,
      mediaFailed: media.failed.length
    }
  })

  // 一个事务写完整条素材的全部图片:逐条自动提交在 WAL 下慢一个数量级
  getDb().transaction(() => {
    for (const m of media.ok) {
      insertAsset({
        contentId: inserted.id,
        kind: m.kind,
        mime: m.mime,
        size: m.size,
        relPath: m.relPath,
        sourceMark: resolved.platform + ':ref'
      })
    }
  })()

  const item = getContentItem(inserted.id)
  if (!item) return { ok: false, error: '入库失败' }
  return { ok: true, item, existed: inserted.existed }
}

export function queryContents(filter: GrowthContentFilter): GrowthListResult {
  return listContents(filter)
}

export function queryContentDetail(id: number): GrowthContentDetail | null {
  return getContentDetail(id)
}

export function patchContent(
  id: number,
  patch: Partial<Pick<GrowthContentItem, 'usage' | 'status' | 'note' | 'score'>>
): boolean {
  return updateContentFields(id, patch)
}
