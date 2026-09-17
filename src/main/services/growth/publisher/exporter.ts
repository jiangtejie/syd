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
import { listOutputAssets } from '../../../db/repos/growthAiRepo'
import { complianceBanner, exportGate, planExportImages } from './exportPlan'

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
  /** 合规块（AIGC 声明 / 来源 / 被扣下的图 / 需确认的提示）：放在最前面，发布前一定看得到 */
  banner: string
  outputs: Array<{ variant: string; title: string; copy: string; hints: string[] }>
}): string {
  const lines: string[] = []
  lines.push('# ' + (input.title || '素材发布包'))
  if (input.banner) {
    lines.push('')
    lines.push(input.banner)
  }
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
 *
 * `targetDir` 用于**批量导出**：调用方先弹一次目录选择，再对多条素材复用同一个父目录
 * （每条素材在父目录下各自建一个「标题-id」子目录，见下面的 dir 生成）。不传则照旧弹选择框。
 */
export async function exportPublishPackage(
  contentId: number,
  outputIds: number[] = [],
  targetDir?: string
): Promise<ExportPackageResult> {
  const detail = getContentDetail(contentId)
  if (!detail) return { ok: false, error: '素材不存在' }

  const allOutputs = listRemixOutputViews(contentId, 30)
  const selectedOutputs =
    outputIds.length > 0
      ? allOutputs.filter((o) => outputIds.includes(o.id))
      : allOutputs.slice(0, 6)

  // 合规硬门禁：命中 block 级（广告法绝对化用语 / 普通食品功效宣称）就**不导出**。
  // 放在弹目录之前：被拦截时不该先让用户挑一遍文件夹再告诉他不行。
  const gate = exportGate([
    detail.title,
    detail.text,
    ...selectedOutputs.flatMap((o) => [o.title, o.copy])
  ])
  if (!gate.ok) return { ok: false, error: gate.error }

  let parentDir = (targetDir ?? '').trim()
  if (!parentDir) {
    const picked = await dialog.showOpenDialog({
      title: '选择发布包导出目录',
      properties: ['openDirectory', 'createDirectory']
    })
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, error: '已取消导出' }
    parentDir = picked.filePaths[0]
  }

  const outputs = selectedOutputs

  const dir = join(
    parentDir,
    safeFileName(detail.title || '素材', { maxLength: 40, fallback: '素材' }) +
      '-' +
      String(contentId)
  )
  const imgDir = join(dir, '图片')
  await mkdir(imgDir, { recursive: true })

  const extra = detail.extra as { remoteMedia?: { videoUrl?: string } }

  // 图片取哪一批：**以产出的图为先**（那是为这条文案挑/生成的），产出没有才退回素材图，
  // 且来源=参考的素材图一张都不打包。规则都在 exportPlan.ts（纯函数，有自检）。
  const outputImages = outputs.flatMap((o) =>
    listOutputAssets(o.id).map((a) => ({ relPath: a.relPath, source: a.source, note: a.note }))
  )
  const contentImages = detail.assets
    .filter((a) => (a.kind === 'cover' || a.kind === 'image') && a.relPath)
    .map((a) => ({ kind: a.kind, relPath: a.relPath }))
  const plan = planExportImages({
    contentUsage: detail.usage,
    contentImages,
    outputImages
  })

  const banner = complianceBanner({
    warnings: gate.warnings,
    withheldRef: plan.withheldRef,
    aiCount: plan.files.filter((f) => f.isAi).length,
    searchCount: plan.files.filter((f) => f.fromSearch).length,
    origin: detail.origin,
    authorName: detail.authorName,
    link: detail.link
  })

  const doc = buildCopyDoc({
    title: detail.title,
    text: detail.text,
    link: detail.link,
    author: detail.authorName,
    origin: detail.origin,
    interactions: detail.interactions,
    videoUrl: extra.remoteMedia?.videoUrl ?? '',
    banner,
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

  // 图片：按计划复制（文件名由计划决定 —— AI 生成图带「AI生成示意图_」前缀）
  const mediaBase = getGrowthMediaDir()
  for (const f of plan.files) {
    try {
      await copyFile(join(mediaBase, f.relPath), join(imgDir, f.name))
      files += 1
    } catch {
      /* 文件缺失跳过 */
    }
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
