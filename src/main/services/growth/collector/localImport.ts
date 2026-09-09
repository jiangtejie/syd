/**
 * 本地素材导入: 把门店自有图片/视频复制进 growth 媒体库并建素材卡(origin=self)。
 * 用途: 爆改需要品牌自有素材, 不能只靠平台链接解析。
 */

import { dialog } from 'electron'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { getGrowthMediaDir } from '../../paths'
import { insertAsset, insertContent } from '../../../db/repos/growthRepo'
import type { GrowthContentKind } from '../../../../shared/growth'

const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif']
const VIDEO_EXT = ['mp4', 'mov', 'webm', 'm4v']
const MAX_BYTES = 500 * 1024 * 1024

export interface ImportLocalResult {
  ok: boolean
  added?: number
  contentId?: number
  skipped?: string[]
  error?: string
}

function kindOf(ext: string): GrowthContentKind | null {
  const e = ext.replace('.', '').toLowerCase()
  if (IMAGE_EXT.includes(e)) return 'image_text'
  if (VIDEO_EXT.includes(e)) return 'video'
  return null
}

/** 复制单文件到 media/<hash2>/<hash><ext>, 返回相对路径 */
async function storeFile(file: string, ext: string): Promise<{ relPath: string; size: number }> {
  const st = await stat(file)
  const hash = createHash('sha1')
    .update(file + ':' + String(st.size) + ':' + String(st.mtimeMs))
    .digest('hex')
  const sub = hash.slice(0, 2)
  const relPath = sub + '/' + hash + ext.toLowerCase()
  await mkdir(join(getGrowthMediaDir(), sub), { recursive: true })
  await copyFile(file, join(getGrowthMediaDir(), relPath))
  return { relPath, size: st.size }
}

/**
 * 弹出文件选择器导入本地素材。
 * 规则: 一次选中的图片合并为一条图文素材(多图); 每个视频各成一条素材。
 */
export async function importLocalMaterials(): Promise<ImportLocalResult> {
  const picked = await dialog.showOpenDialog({
    title: '选择本地素材(门店实拍图/视频)',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '图片 / 视频', extensions: [...IMAGE_EXT, ...VIDEO_EXT] }]
  })
  if (picked.canceled || picked.filePaths.length === 0) {
    return { ok: false, error: '已取消选择' }
  }

  const images: string[] = []
  const videos: string[] = []
  const skipped: string[] = []
  for (const f of picked.filePaths) {
    const kind = kindOf(extname(f))
    if (!kind) {
      skipped.push(basename(f))
      continue
    }
    try {
      const st = await stat(f)
      if (st.size === 0 || st.size > MAX_BYTES) {
        skipped.push(basename(f) + '(大小超限)')
        continue
      }
    } catch {
      skipped.push(basename(f) + '(读取失败)')
      continue
    }
    if (kind === 'video') videos.push(f)
    else images.push(f)
  }

  let firstId = 0
  let added = 0

  // 1) 图片合并为一条素材
  if (images.length > 0) {
    const now = Date.now()
    const title = basename(images[0], extname(images[0]))
    const res = insertContent({
      dedupeKey: 'local:batch:' + String(now) + ':' + String(images.length),
      origin: 'self',
      kind: 'image_text',
      title,
      text: '',
      usage: 'own',
      note: '本地上传素材(' + String(images.length) + ' 张图)',
      extra: { localUpload: true }
    })
    if (firstId === 0) firstId = res.id
    let idx = 0
    for (const f of images) {
      try {
        const stored = await storeFile(f, extname(f))
        insertAsset({
          contentId: res.id,
          kind: idx === 0 ? 'cover' : 'image',
          relPath: stored.relPath,
          size: stored.size,
          sourceMark: 'self:local'
        })
        added += 1
      } catch {
        skipped.push(basename(f) + '(复制失败)')
      }
      idx += 1
    }
  }

  // 2) 视频各自一条素材
  for (const f of videos) {
    try {
      const stored = await storeFile(f, extname(f))
      const res = insertContent({
        dedupeKey: 'local:file:' + stored.relPath,
        origin: 'self',
        kind: 'video',
        title: basename(f, extname(f)),
        text: '',
        usage: 'own',
        note: '本地上传视频',
        extra: { localUpload: true }
      })
      insertAsset({
        contentId: res.id,
        kind: 'video',
        relPath: stored.relPath,
        size: stored.size,
        sourceMark: 'self:local'
      })
      if (firstId === 0) firstId = res.id
      added += 1
    } catch {
      skipped.push(basename(f) + '(复制失败)')
    }
  }

  if (added === 0) {
    return { ok: false, error: '没有导入任何文件' + (skipped.length ? '(跳过: ' + skipped.join(', ') + ')' : '') }
  }
  return { ok: true, added, contentId: firstId, skipped }
}
