/**
 * AI 拆解服务: 复用客服 AI 通道(services/ai provider, 同 baseUrl/key/model)。
 * 爆款 → 结构化拆解卡(结构维度 + 视觉维度, 落 growth_decomp), 供爆改与图生图使用。
 *
 * 历史说明:
 * - 原有 `remixContent`(一键爆改: 拆解 → 标题x5 + 正文x2 → 落 remix_job/remix_output)已由
 *   「营销 → AI 工作台」的工具承接(growth_rewrite_title/copy + growth_update_output), 且无任何调用方,
 *   故删除以免两份实现漂移; 如需恢复, 见 git 历史(提交 f650c4e 之前)。
 * - 原有 `recordPublish`(发布登记 + 效果回填 → growth_metric_snapshot + 重算素材分)已按用户决定
 *   整体下线: 那一步是纯手工录数字, 运营不会真的去填。历史行仍在老库的 growth_metric_snapshot 里。
 */

import { createAiProvider } from '../../ai/provider'
import { describeModelError } from '../../ai/modelErrors'
import { getContentItem, setDecomp } from '../../../db/repos/growthRepo'
import { buildAnalyzePrompt, parseModelJson } from './prompts'
import { hasVisualFacts, readVisualFacts } from '../ai/imageStrategy'
import { createLogger } from '../../logging'

const remixLog = createLogger('growth-remix')

/** AI 未启用/未配置(可读提示, 引导到设置) */
export class AiSetupError extends Error {}

const AI_SETUP_MSG =
  'AI 通道未就绪: 请到「设置 → AI 模型」配置并启用(与客服回复建议共用同一通道, 无需额外 Key)'

function requireProvider(): NonNullable<ReturnType<typeof createAiProvider>> {
  const provider = createAiProvider('growth-remix')
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

/**
 * 拆解卡的版本。**改了 buildAnalyzePrompt 的输出结构就要把它加一** ——
 * 建任务时按它判断旧卡要不要重拆（见 ai/taskService），不然老卡永远缺新维度。
 * v2: 增加 visual（构图/机位/光线/色调/留白/元素/图上文字），供图生图锁定「保持」。
 */
export const ANALYZE_VER = 'analyze-v2'

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
  // 视觉维度（模型没给/给空就存 null：宁可不写，也别写一个空对象让下游以为有事实）
  const visual = readVisualFacts(parsed['visual'])
  setDecomp(contentId, {
    modelVer: ANALYZE_VER,
    structure: structure as unknown as Record<string, unknown>,
    visual: hasVisualFacts(visual) ? (visual as unknown as Record<string, unknown>) : null,
    commentTopics: (structure as { commentTopics: string[] }).commentTopics
  })
  return JSON.stringify(hasVisualFacts(visual) ? { ...structure, visual } : structure, null, 2)
}
