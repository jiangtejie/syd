/**
 * AI 拆解 / 文案爆改 服务: 复用客服 AI 通道(services/ai provider, 同 baseUrl/key/model)。
 * - 拆解: 爆款 → 结构化拆解卡(落 growth_decomp);
 * - 爆改: 拆解卡 + 快捷风格 → 标题 x5 + 正文 x2(落 remix_job / remix_output), 附合规提示;
 * - 回填: 发布登记 → growth_metric_snapshot, 素材分自动更新。
 */

import { createAiProvider } from '../../ai/provider'
import { describeModelError } from '../../ai/modelErrors'
import {
  getContentDetail,
  getContentItem,
  setDecomp,
  interactionScoreOf,
  updateContentFields
} from '../../../db/repos/growthRepo'
import {
  createRemixJob,
  createRemixOutput,
  finishRemixJob,
  insertMetricSnapshot,
  listMetricViews,
  listRemixOutputViews
} from '../../../db/repos/growthOpsRepo'
import {
  buildAnalyzePrompt,
  buildRemixPrompt,
  normalizeRemixResult,
  parseModelJson
} from './prompts'
import { checkComplianceBatch } from './compliance'
import { createLogger } from '../../logging'
import type {
  GrowthMetricView,
  GrowthRemixOutputView,
  GrowthRemixStyle
} from '../../../../shared/growth'

const remixLog = createLogger('growth-remix')

/** AI 未启用/未配置(可读提示, 引导到设置) */
export class AiSetupError extends Error {}

const AI_SETUP_MSG =
  'AI 通道未就绪: 请到「设置 → AI 模型」配置并启用(与客服回复建议共用同一通道, 无需额外 Key)'

function requireProvider(): NonNullable<ReturnType<typeof createAiProvider>> {
  const provider = createAiProvider()
  if (!provider) throw new AiSetupError(AI_SETUP_MSG)
  return provider
}

function llmFail(e: unknown): never {
  const label = describeModelError(e)
  if (label) throw new Error(label)
  throw new Error(e instanceof Error ? e.message : String(e))
}

/** 一次 JSON 生成(输出失败给可读错误) */
async function generateJson(system: string, user: string): Promise<Record<string, unknown>> {
  const provider = requireProvider()
  let raw = ''
  try {
    raw = await provider.complete(system, user, { maxTokens: 1600 })
  } catch (e) {
    llmFail(e)
  }
  const parsed = parseModelJson(raw)
  if (!parsed) {
    remixLog.warn('model JSON unparsable, raw head: ' + raw.slice(0, 200))
    throw new Error('AI 返回内容格式异常, 请重试一次')
  }
  return parsed
}

/** 素材 id → 拆解卡落库(growth_decomp); 返回 structure 文本供爆改用 */
export async function analyzeContent(contentId: number): Promise<string> {
  const item = getContentItem(contentId)
  if (!item) throw new Error('素材不存在')
  const { system, user } = buildAnalyzePrompt(item)
  const parsed = await generateJson(system, user)
  const structure = {
    hook: typeof parsed['hook'] === 'string' ? parsed['hook'] : '',
    structure: typeof parsed['structure'] === 'string' ? parsed['structure'] : '',
    sellingPoints: Array.isArray(parsed['sellingPoints'])
      ? parsed['sellingPoints'].filter((x): x is string => typeof x === 'string')
      : [],
    titlePatterns: Array.isArray(parsed['titlePatterns'])
      ? parsed['titlePatterns'].filter((x): x is string => typeof x === 'string')
      : [],
    commentTopics: Array.isArray(parsed['commentTopics'])
      ? parsed['commentTopics'].filter((x): x is string => typeof x === 'string')
      : [],
    whyWorks: typeof parsed['whyWorks'] === 'string' ? parsed['whyWorks'] : ''
  }
  setDecomp(contentId, {
    modelVer: 'analyze-v1',
    structure: structure as unknown as Record<string, unknown>,
    visual: null,
    commentTopics: (structure as { commentTopics: string[] }).commentTopics
  })
  return JSON.stringify(structure, null, 2)
}

/** 拆解卡文本(供爆改输入); 缺失时先自动拆解 */
async function ensureDecompText(contentId: number): Promise<string> {
  const detail = getContentDetail(contentId)
  const structure = detail?.decomp?.structure
  if (detail?.decomp?.modelVer && structure && Object.keys(structure).length > 0) {
    return JSON.stringify(structure, null, 2)
  }
  return await analyzeContent(contentId)
}

/**
 * 一键爆改: 拆解 → 风格化生成标题/正文 → 合规提示 → 落库。
 * 返回本次产出块(按 id 倒序的最新内容)。
 */
export async function remixContent(
  contentId: number,
  style: GrowthRemixStyle
): Promise<GrowthRemixOutputView[]> {
  const item = getContentItem(contentId)
  if (!item) throw new Error('素材不存在')
  const decompText = await ensureDecompText(contentId)

  const { system, user } = buildRemixPrompt({ item, decompText, style })
  const parsed = await generateJson(system, user)
  const { titles, copies } = normalizeRemixResult(parsed)
  if (titles.length === 0 && copies.length === 0) {
    throw new Error('AI 未返回可用文案, 请重试或更换风格')
  }

  const jobId = createRemixJob(contentId, style)
  try {
    const allTexts: string[] = []
    if (titles.length > 0) {
      const hints = checkComplianceBatch(titles)
      createRemixOutput({
        jobId,
        contentId,
        variant: 'titles',
        title: titles.join('\n'),
        copy: '',
        complianceHints: hints
      })
      allTexts.push(...titles)
    }
    copies.forEach((copy, i) => {
      createRemixOutput({
        jobId,
        contentId,
        variant: 'copy' + String(i + 1),
        title: '',
        copy,
        complianceHints: checkComplianceBatch([copy])
      })
      allTexts.push(copy)
    })
    finishRemixJob(jobId, { ok: true })
    remixLog.info('remix done content=' + String(contentId) + ' style=' + style)
    return listRemixOutputViews(contentId, 12)
  } catch (e) {
    finishRemixJob(jobId, { ok: false, error: e instanceof Error ? e.message : String(e) })
    throw e
  }
}

/**
 * 发布登记 + 效果回填: 写 metric 快照并把回流贡献并入素材分。
 * score = 基础互动分 + 回流(赞) + 新增关注 x2 + 线索 x30 + 金额。
 */
export function recordPublish(
  contentId: number,
  input: {
    channel: string
    likes: number
    collects: number
    comments: number
    shares: number
    follows: number
    leads: number
    amount: number
    /** 归因: 采用的爆改产出(可空) */
    outputId?: number | null
  }
): { score: number; metric: GrowthMetricView } {
  const item = getContentItem(contentId)
  if (!item) throw new Error('素材不存在')
  insertMetricSnapshot(contentId, { ...input, outputId: input.outputId ?? null })
  const base = interactionScoreOf(item.interactions)
  const score = Math.round(base + input.likes + input.follows * 2 + input.leads * 30 + input.amount)
  updateContentFields(contentId, { score })
  const metric = listMetricViews(contentId, 1)[0]
  if (!metric) throw new Error('回填失败')
  return { score, metric }
}
