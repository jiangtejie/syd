/**
 * 舆情监控服务: 链接入库(解析原帖) → 评论录入 → 智能诊断 → 状态流转。
 * 数据来源:
 * - 链接: 复用采集内核解析抖音/小红书原帖(标题/正文/作者/互动/封面), 存原链接可回看;
 * - 评论: 手动粘贴(平台限制无法自动抓取评论区), 支持「赞数|作者|内容」批量格式;
 * - 诊断: analyze.ts(规则词库 + 模型归因)融合评级。
 */

import { resolveShareText } from '../collector/resolver'
import { downloadMediaAssets } from '../collector/media/assetStore'
import { createLogger } from '../../logging'
import {
  buzzOverview,
  getMention,
  insertComment,
  insertMention,
  listComments,
  listMentions,
  refreshHighComments,
  removeComment,
  removeMention,
  updateMention,
  type BuzzMentionView,
  type BuzzOverview
} from '../../../db/repos/growthBuzzRepo'
import { insertAsset, insertContent } from '../../../db/repos/growthRepo'
import { createTaskFromContent } from '../ai/taskService'
import { diagnoseMention, type BuzzDiagnosis } from './analyze'
import { sha1Of } from '../_hash'
import { errText } from '../_errors'

const buzzLog = createLogger('growth-buzz')

export interface BuzzAddResult {
  ok: boolean
  id?: number
  existed?: boolean
  mention?: BuzzMentionView
  diagnosis?: BuzzDiagnosis
  /** 诊断失败时的可读原因(入库成功仍返回 ok=true) */
  diagnosisError?: string
  error?: string
}

/**
 * 链接 → 舆情记录。自动解析原帖并抓取封面(便于在卡片上直观确认)。
 * 重复链接(同平台同内容 ID)不重复入库, 直接返回既有记录。
 */
export async function addBuzzLink(input: {
  storeId: number | null
  text: string
  autoDiagnose?: boolean
}): Promise<BuzzAddResult> {
  const text = (input.text || '').trim()
  if (!text) return { ok: false, error: '请粘贴抖音/小红书链接或分享口令' }

  let resolved
  try {
    resolved = await resolveShareText(text)
  } catch (e) {
    return { ok: false, error: errText(e) }
  }

  const dedupeKey = resolved.platformItemId
    ? 'buzz:' + resolved.platform + ':item:' + resolved.platformItemId
    : 'buzz:' + resolved.platform + ':url:' + sha1Of(resolved.link || text)

  const cover = resolved.coverUrl || resolved.imageUrls[0] || ''
  const media = cover
    ? await downloadMediaAssets([cover], resolved.platform)
    : { ok: [], failed: [] }
  const assets = media.ok.map((m) => m.relPath)

  const inserted = insertMention({
    storeId: input.storeId ?? null,
    platform: resolved.platform,
    kind: resolved.kind,
    url: resolved.link,
    platformItemId: resolved.platformItemId,
    title: resolved.title || (resolved.desc || '').slice(0, 80) || '(无标题内容)',
    contentText: resolved.desc || resolved.title || '',
    authorName: resolved.authorName,
    authorId: resolved.authorId,
    publishedAt: resolved.publishedAt,
    interactions: {
      likes: resolved.likes,
      collects: resolved.collects,
      comments: resolved.comments,
      shares: resolved.shares
    },
    assets,
    source: 'link',
    dedupeKey
  })

  buzzLog.info(
    'add link platform=' +
      resolved.platform +
      ' id=' +
      String(inserted.id) +
      ' existed=' +
      String(inserted.existed) +
      ' cover=' +
      String(assets.length)
  )

  const mention = getMention(inserted.id)
  if (!mention) return { ok: false, error: '入库失败' }

  if (input.autoDiagnose === false || inserted.existed) {
    return { ok: true, id: inserted.id, existed: inserted.existed, mention }
  }
  try {
    const diagnosis = await diagnoseMention(inserted.id)
    return {
      ok: true,
      id: inserted.id,
      existed: false,
      mention: getMention(inserted.id) ?? mention,
      diagnosis
    }
  } catch (e) {
    return { ok: true, id: inserted.id, existed: false, mention, diagnosisError: errText(e) }
  }
}

/** 解析粘贴的评论: 支持「赞数|作者|内容」/「作者|内容」/纯内容, 也支持 tab 分隔 */
export function parseCommentText(
  raw: string
): Array<{ likes: number; authorName: string; content: string }> {
  const out: Array<{ likes: number; authorName: string; content: string }> = []
  const seen = new Set<string>()
  for (const line of (raw || '').split(/\r?\n/)) {
    // 只去掉列表符号/序号前缀, 不能吃掉行首的赞数(如「128|作者|内容」)
    const t = line
      .replace(/^[\s\-*·•]+/, '')
      .replace(/^\d+\s*[.、)]\s*/, '')
      .trim()
    if (!t) continue
    const parts = t.split(/[|\t]/).map((p) => p.trim())
    let likes = 0
    let authorName = ''
    let content = t
    if (parts.length >= 3) {
      const n = Number(String(parts[0]).replace(/[^\d]/g, ''))
      if (Number.isFinite(n) && String(parts[0]).length <= 8) {
        likes = n
        authorName = parts[1]
        content = parts.slice(2).join(' | ')
      } else {
        authorName = parts[0]
        content = parts.slice(1).join(' | ')
      }
    } else if (parts.length === 2) {
      const n = Number(String(parts[0]).replace(/[^\d]/g, ''))
      if (Number.isFinite(n) && /^\d+$/.test(String(parts[0]).trim())) {
        likes = n
        content = parts[1]
      } else {
        authorName = parts[0]
        content = parts[1]
      }
    }
    content = content.trim()
    if (!content) continue
    const key = content.slice(0, 120)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ likes, authorName, content: content.slice(0, 1000) })
  }
  return out
}

export interface BuzzCommentsResult {
  ok: boolean
  added?: number
  skipped?: number
  total?: number
  diagnosis?: BuzzDiagnosis
  diagnosisError?: string
  error?: string
}

/** 录入评论区(高赞优先由赞数自动判定), 随后重跑诊断 */
export async function addBuzzComments(input: {
  mentionId: number
  raw: string
  source?: string
  autoDiagnose?: boolean
}): Promise<BuzzCommentsResult> {
  const mention = getMention(input.mentionId)
  if (!mention) return { ok: false, error: '舆情记录不存在' }
  const parsed = parseCommentText(input.raw)
  if (parsed.length === 0) return { ok: false, error: '未识别到评论内容' }

  const existed = new Set(listComments(input.mentionId).map((c) => c.content.slice(0, 120)))
  let added = 0
  let skipped = 0
  for (const c of parsed) {
    if (existed.has(c.content.slice(0, 120))) {
      skipped += 1
      continue
    }
    insertComment({
      mentionId: input.mentionId,
      authorName: c.authorName,
      content: c.content,
      likes: c.likes,
      isHigh: false,
      source: input.source || 'manual'
    })
    added += 1
  }
  refreshHighComments(input.mentionId)
  buzzLog.info(
    'add comments mention=' +
      String(input.mentionId) +
      ' added=' +
      String(added) +
      ' skipped=' +
      String(skipped)
  )

  const total = listComments(input.mentionId).length
  if (input.autoDiagnose === false || added === 0) return { ok: true, added, skipped, total }
  try {
    const diagnosis = await diagnoseMention(input.mentionId)
    return { ok: true, added, skipped, total, diagnosis }
  } catch (e) {
    return { ok: true, added, skipped, total, diagnosisError: errText(e) }
  }
}

export function queryBuzzOverview(storeId?: number | null): BuzzOverview {
  return buzzOverview(storeId ?? null)
}

export function queryBuzzList(filter: {
  storeId?: number | null
  platform?: string
  sentiment?: string
  status?: string
  keyword?: string
  limit?: number
  offset?: number
}): { items: BuzzMentionView[]; total: number } {
  return listMentions(filter)
}

export function queryBuzzDetail(
  id: number
): { mention: BuzzMentionView; comments: ReturnType<typeof listComments> } | null {
  const mention = getMention(id)
  if (!mention) return null
  return { mention, comments: listComments(id) }
}

export function patchBuzz(
  id: number,
  patch: {
    storeId?: number | null
    status?: string
    note?: string
    sentiment?: string
    score?: number
  }
): boolean {
  if (!getMention(id)) return false
  updateMention(id, patch)
  return true
}

export function deleteBuzz(id: number): boolean {
  if (!getMention(id)) return false
  removeMention(id)
  buzzLog.info('remove mention id=' + String(id))
  return true
}

export function deleteBuzzComment(id: number): boolean {
  removeComment(id)
  return true
}

/** 手动/批量重跑诊断 */
export async function diagnoseBuzz(id: number, useModel?: boolean): Promise<BuzzDiagnosis> {
  return await diagnoseMention(id, { useModel })
}

export async function diagnoseBuzzBatch(
  ids: number[],
  useModel?: boolean
): Promise<{ ok: number; failed: number }> {
  let ok = 0
  let failed = 0
  for (const id of ids.slice(0, 20)) {
    try {
      await diagnoseMention(id, { useModel })
      ok += 1
    } catch (e) {
      failed += 1
      buzzLog.warn('batch diagnose failed id=' + String(id) + ' ' + errText(e))
    }
  }
  return { ok, failed }
}

export interface BuzzToWorkbenchResult {
  ok: boolean
  taskId?: number
  contentId?: number
  existed?: boolean
  error?: string
}

/**
 * 舆情 → AI 工作台闭环: 把原帖作为「内部参考素材」入仓库, 并直接建一个爆改任务,
 * 目标文案 = 公开回应 + 私信话术 + 正向选题(诊断结论一并写进任务开场白)。
 */
export async function sendBuzzToWorkbench(id: number): Promise<BuzzToWorkbenchResult> {
  const mention = getMention(id)
  if (!mention) return { ok: false, error: '舆情记录不存在' }

  const dedupeKey =
    'buzz-src:' +
    mention.platform +
    ':' +
    (mention.platformItemId || sha1Of(mention.url || String(id)))
  const inserted = insertContent({
    dedupeKey,
    origin: mention.platform,
    kind: mention.kind === 'video' ? 'video' : 'image_text',
    platformItemId: mention.platformItemId,
    storeId: mention.storeId,
    title: mention.title,
    text: mention.contentText,
    authorName: mention.authorName,
    authorId: mention.authorId,
    link: mention.url,
    publishedAt: mention.publishedAt,
    tags: ['舆情'],
    usage: 'ref',
    interactions: mention.interactions,
    note: '来源: 舆情监控 #' + String(id),
    extra: { buzzMentionId: id }
  })
  if (!inserted.existed && mention.assets[0]) {
    insertAsset({
      contentId: inserted.id,
      kind: 'cover',
      relPath: mention.assets[0],
      sourceMark: mention.platform + ':buzz'
    })
  }

  const summary =
    mention.diagnosis && typeof mention.diagnosis['summary'] === 'string'
      ? String(mention.diagnosis['summary'])
      : '暂无诊断结论'
  const goal = [
    '这是一条门店舆情(平台 ' +
      mention.platform +
      ', 情绪 ' +
      (mention.sentiment || '待诊断') +
      ', 评分 ' +
      String(mention.score) +
      ', 风险 ' +
      (mention.riskLevel || '未评级') +
      ')。',
    '诊断结论: ' + summary,
    '请产出: 1) 评论区公开回应(礼貌、不辩解、给动作, 可直接复制发布) 2) 私信致歉/补偿话术 3) 一条正向内容选题(把问题转成信任点)。'
  ].join('\n')

  const res = await createTaskFromContent({
    contentId: inserted.id,
    storeId: mention.storeId,
    goal
  })
  if (!res.ok) return { ok: false, error: res.error || '创建任务失败' }
  buzzLog.info(
    'send to workbench mention=' +
      String(id) +
      ' task=' +
      String(res.taskId) +
      ' content=' +
      String(inserted.id)
  )
  return { ok: true, taskId: res.taskId, contentId: inserted.id, existed: inserted.existed }
}
