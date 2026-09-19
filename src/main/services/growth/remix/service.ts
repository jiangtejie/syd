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

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeImage } from 'electron'
import { createAiProvider } from '../../ai/provider'
import { getConfig } from '../../../db/repos/config'
import { planOutputBudget } from '../../ai/outputBudget'
import { getContentDetail } from '../../../db/repos/growthRepo'
import { getGrowthMediaDir } from '../../paths'
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

/**
 * 一次 JSON 生成(输出失败给可读错误)。images 传 data URI 时按多模态发出（拆画面必须看得见图）。
 *
 * **输出被截断时自动抬预算重来一次**：实测（2026-09-19 日志）带图拆解连挂三次，
 * 每次都是 `model JSON unparsable, raw head: {` —— 模型在写一半时被 maxOutputTokens 掐断。
 * 原因不是"通道不支持图片"，而是**思考也算进输出预算**：configured 模型名（如 deepseek-v4-flash）
 * 不在 looksLikeReasoningModel 的名单里，planOutputBudget 就按 1600 给，思考吃光后 JSON 只剩半个括号。
 * 与其猜模型名，不如按结果补救：解析失败 → attempt+1（预算 ×4）重来一次。
 */
async function generateJson(
  system: string,
  user: string,
  images?: string[]
): Promise<Record<string, unknown>> {
  const provider = requireProvider()
  const model = getConfig('ai.model')
  const configured = getConfig('ai.maxOutputTokens')
  // 带图的答案更长（画面字段逐项写），起步就给宽一点
  const fallback = images && images.length > 0 ? 2400 : 1600
  let lastRaw = ''
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const budget = planOutputBudget({ configured, fallback, model, attempt })
    let raw = ''
    try {
      raw = await provider.complete(system, user, { maxTokens: budget.maxTokens, images })
    } catch (e) {
      llmFail(e)
    }
    const parsed = parseModelJson(raw)
    if (parsed) {
      if (attempt > 0) {
        remixLog.info(
          'JSON parse recovered on attempt ' +
            String(attempt) +
            ' (maxTokens=' +
            String(budget.maxTokens) +
            ')'
        )
      }
      return parsed
    }
    lastRaw = raw
    remixLog.warn(
      'model JSON unparsable (attempt=' +
        String(attempt) +
        ' maxTokens=' +
        String(budget.maxTokens) +
        ' chars=' +
        String(raw.length) +
        '), raw head: ' +
        raw.slice(0, 400)
    )
  }
  remixLog.warn('JSON still unparsable after escalation, tail: ' + lastRaw.slice(-200))
  throw new Error('AI 返回内容格式异常, 请重试一次')
}

/**
 * 拆解卡的版本。**改了 buildAnalyzePrompt 的输出结构就要把它加一** ——
 * 建任务时按它判断旧卡要不要重拆（见 ai/taskService），不然老卡永远缺新维度。
 * v2: 增加 visual（构图/机位/光线/色调/留白/元素/图上文字），供图生图锁定「保持」。
 */
export const ANALYZE_VER = 'analyze-v2'

/**
 * 取素材的一张本地图 → data URI（给拆解当视觉输入）。
 *
 * 选图顺序：先本店实拍（self:*），再 AI 生成图，最后外部参考图 —— 拆解要拆的是**这条爆款的画面**，
 * 所以参考图（<平台>:ref）本来就是主要目标；但本店图在前更符合"我们自己的画面"的语义。
 * 尺寸压到 1024 宽、JPEG 质量 78：vision 模型够用，base64 也不会把请求撑爆。
 */
async function loadReferenceImage(contentId: number): Promise<string | null> {
  const detail = getContentDetail(contentId)
  const list = detail?.assets ?? []
  const pick =
    list.find((a) => a.sourceMark?.startsWith('self:') && a.relPath) ??
    list.find((a) => a.sourceMark?.startsWith('gen:') && a.relPath) ??
    list.find((a) => !!a.relPath)
  if (!pick?.relPath) return null
  try {
    const buf = await readFile(join(getGrowthMediaDir(), pick.relPath))
    if (buf.length === 0) return null
    const img = nativeImage.createFromBuffer(buf)
    if (!img.isEmpty()) {
      const { width, height } = img.getSize()
      const scaled =
        width > 1024
          ? img.resize({ width: 1024, height: Math.round((height * 1024) / width) })
          : img
      return 'data:image/jpeg;base64,' + scaled.toJPEG(78).toString('base64')
    }
    const mime = pick.mime || 'image/png'
    return 'data:' + mime + ';base64,' + buf.toString('base64')
  } catch (e) {
    remixLog.warn('load reference image failed: ' + (e instanceof Error ? e.message : String(e)))
    return null
  }
}

/** 素材 id → 拆解卡落库(growth_decomp); 返回 structure 文本供爆改用 */
export async function analyzeContent(contentId: number): Promise<string> {
  const item = getContentItem(contentId)
  if (!item) throw new Error('素材不存在')
  /**
   * 参考图 → data URI。**这是「拆画面」能不能成立的前提**：
   * 此前 analyzeContent 只把标题/正文文本发给模型，却要求它输出构图/机位/光线 ——
   * 模型从没看到过那张图，按 prompt 里"没有图片就留空"照办，于是 visual_json 永远是空的
   * （实测：素材 #9 是 analyze-v2 的卡，visual 仍是 {}），图生图的「保持」也就永远退回通用口径。
   */
  const image = await loadReferenceImage(contentId)
  const { system, user } = buildAnalyzePrompt(item, !!image)
  let parsed: Record<string, unknown>
  try {
    parsed = await generateJson(system, user, image ? [image] : undefined)
  } catch (e) {
    // 通道/模型不支持图片输入时不硬失败：退回纯文本拆解（结构维度照旧），并说清视觉维度为什么空
    if (!image) throw e
    remixLog.warn(
      'analyze with image failed, retry text-only: ' + (e instanceof Error ? e.message : String(e))
    )
    const textOnly = buildAnalyzePrompt(item, false)
    parsed = await generateJson(textOnly.system, textOnly.user)
  }
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
