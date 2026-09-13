/**
 * AI 拆解 / 发布回填 服务: 复用客服 AI 通道(services/ai provider, 同 baseUrl/key/model)。
 * - 拆解: 爆款 → 结构化拆解卡(落 growth_decomp);
 * - 回填: 发布登记 → growth_metric_snapshot, 素材分自动更新。
 *
 * 历史说明: 这里原有 `remixContent`(一键爆改: 拆解 → 标题x5 + 正文x2 → 落 remix_job/remix_output)。
 * 该链路已由「营销 → AI 工作台」的工具承接(growth_rewrite_title/copy + growth_update_output), 且无任何调用方,
 * 故删除以免两份实现漂移; 如需恢复, 见 git 历史(提交 f650c4e 之前)。
 */

import { createAiProvider } from '../../ai/provider'
import { describeModelError } from '../../ai/modelErrors'
import {
  getContentItem,
  setDecomp,
  interactionScoreOf,
  updateContentFields
} from '../../../db/repos/growthRepo'
import { insertMetricSnapshot, listMetricViews } from '../../../db/repos/growthOpsRepo'
import { buildAnalyzePrompt, parseModelJson } from './prompts'
import { createLogger } from '../../logging'
import type { GrowthMetricView } from '../../../../shared/growth'

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
