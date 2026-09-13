/**
 * 发布包导出: 把一条素材(文案+本地图片+视频直链)与选中的爆改产出
 * 导出为文件夹, 供小红书/抖音人工发布或归档。
 */

import { dialog } from 'electron'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { getGrowthMediaDir } from '../../paths'
import { safeFileName } from '../../_filename'
import { getContentDetail } from '../../../db/repos/growthRepo'
import { listRemixOutputViews } from '../../../db/repos/growthOpsRepo'

export interface ExportPackageResult {
  ok: boolean
  dir?: string
  files?: number
  error?: string
}

function buildCopyDoc(input: {
  title: string
  text: string
  link: string
  author: string
  origin: string
  interactions: { likes: number; collects: number; comments: number; shares: number }
  videoUrl: string
  outputs: Array<{ variant: string; title: string; copy: string; hints: string[] }>
}): string {
  const lines: string[] = []
  lines.push('# ' + (input.title || '素材发布包'))
  lines.push('')
  lines.push('- 来源: ' + input.origin + (input.author ? ' · ' + input.author : ''))
  if (input.link) lines.push('- 原链接: ' + input.link)
  lines.push(
    '- 参考互动: 赞 ' +
      String(input.interactions.likes) +
      ' / 藏 ' +
      String(input.interactions.collects) +
      ' / 评 ' +
      String(input.interactions.comments) +
      ' / 转 ' +
      String(input.interactions.shares)
  )
  if (input.videoUrl) lines.push('- 视频直链: ' + input.videoUrl)
  lines.push('')
  if (input.text) {
    lines.push('## 参考文案')
    lines.push('')
    lines.push(input.text)
    lines.push('')
  }
  for (const o of input.outputs) {
    lines.push('## 爆改产出 · ' + o.variant)
    lines.push('')
    if (o.title) {
      lines.push('### 标题')
      lines.push('')
      lines.push(o.title)
      lines.push('')
    }
    if (o.copy) {
      lines.push('### 正文')
      lines.push('')
      lines.push(o.copy)
      lines.push('')
    }
    if (o.hints.length > 0) {
      lines.push('> 合规提示: ' + o.hints.join('; '))
      lines.push('')
    }
  }
  lines.push('---')
  lines.push('发布前请人工核对: 占位符【店名/菜品/价格/活动】替换为门店真实信息。')
  return lines.join('\n')
}

/**
 * 导出发布包。outputIds 为空则导出全部最新爆改产出。
 */
export async function exportPublishPackage(
  contentId: number,
  outputIds: number[] = []
): Promise<ExportPackageResult> {
  const detail = getContentDetail(contentId)
  if (!detail) return { ok: false, error: '素材不存在' }

  const picked = await dialog.showOpenDialog({
    title: '选择发布包导出目录',
    properties: ['openDirectory', 'createDirectory']
  })
  if (picked.canceled || !picked.filePaths[0]) return { ok: false, error: '已取消导出' }

  const allOutputs = listRemixOutputViews(contentId, 30)
  const outputs =
    outputIds.length > 0
      ? allOutputs.filter((o) => outputIds.includes(o.id))
      : allOutputs.slice(0, 6)

  const dir = join(
    picked.filePaths[0],
    safeFileName(detail.title || '素材', { maxLength: 40, fallback: '素材' }) +
      '-' +
      String(contentId)
  )
  const imgDir = join(dir, '图片')
  await mkdir(imgDir, { recursive: true })

  const extra = detail.extra as { remoteMedia?: { videoUrl?: string } }
  const doc = buildCopyDoc({
    title: detail.title,
    text: detail.text,
    link: detail.link,
    author: detail.authorName,
    origin: detail.origin,
    interactions: detail.interactions,
    videoUrl: extra.remoteMedia?.videoUrl ?? '',
    outputs: outputs.map((o) => ({
      variant: o.variant === 'titles' ? '标题组' : o.variant,
      title: o.variant === 'titles' ? o.title : '',
      copy: o.variant === 'titles' ? '' : o.copy,
      hints: o.complianceHints
    }))
  })

  let files = 0
  await writeFile(join(dir, '文案.md'), doc, 'utf8')
  files += 1

  // 图片: 复制本地已下载资产
  const mediaBase = getGrowthMediaDir()
  const imgs = detail.assets.filter((a) => (a.kind === 'cover' || a.kind === 'image') && a.relPath)
  let seq = 1
  for (const a of imgs) {
    const src = join(mediaBase, a.relPath)
    const ext = a.relPath.slice(a.relPath.lastIndexOf('.')) || '.jpg'
    const name = (seq === 1 ? '封面' : '图' + String(seq)) + ext
    try {
      await copyFile(src, join(imgDir, name))
      files += 1
    } catch {
      /* 文件缺失跳过 */
    }
    seq += 1
  }
  // 视频资产(本地上传的视频)也复制
  for (const a of detail.assets.filter((x) => x.kind === 'video' && x.relPath)) {
    try {
      await copyFile(join(mediaBase, a.relPath), join(dir, basename(a.relPath)))
      files += 1
    } catch {
      /* skip */
    }
  }
  if (extra.remoteMedia?.videoUrl) {
    await writeFile(join(dir, '视频直链.txt'), extra.remoteMedia.videoUrl, 'utf8')
    files += 1
  }
  return { ok: true, dir, files }
}
