/**
 * 营销 AI 工作台对话引擎: 复用与客服工作台同一套 AI SDK 通道/事件通道/审批桥,
 * 但注入营销域 system(门店事实卡 + 素材拆解 + 目标)与营销工具组。
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { stepCountIs, streamText, type ModelMessage } from 'ai'
import { appendChatMessage, listChatMessages } from '../../../db/repos/chatRepo'
import { getConfig } from '../../../db/repos/config'
import {
  budgetExhaustedMessage,
  looksBudgetExhausted,
  planOutputBudget
} from '../../ai/outputBudget'
import { getTask, touchTask, updateTask } from '../../../db/repos/growthAiRepo'
import { readProviderConfig } from '../../ai/provider'
import { describeModelError } from '../../ai/modelErrors'
import { emitWorkbenchEvent } from '../../ai/workbench/events'
import { brandBrief, buildGrowthToolSet, itemBrief, storeBrief } from './growthTools'
import { createLogger } from '../../logging'

const log = createLogger('growth-ai')

const running = new Map<number, AbortController>()

/** 主循环输出预算默认值（思考型模型的思考也算在里面，见 services/ai/outputBudget.ts） */
const DEFAULT_OUTPUT_TOKENS = 3000

const GOAL_LABEL: Record<string, string> = {
  image_text: '小红书/抖音图文',
  video: '短视频脚本与画面',
  moments: '微信朋友圈',
  group: '客户群群发'
}

function buildGrowthSystem(
  taskId: number,
  contentId: number,
  storeId: number | null,
  goal: string
): string {
  return [
    '你是餐饮门店的内容运营助理, 正在与运营人员一起把一条同行爆款素材改造成本店可发布的原创内容。',
    '任务目标: ' + (GOAL_LABEL[goal] ?? goal),
    '',
    '【门店事实卡】(只能使用这里的事实; 缺失的字段必须追问用户或用占位符如【地址】, 严禁编造)',
    storeBrief(storeId),
    '',
    '【品牌资料包】(品牌层面的统一口径: 文案与生图都按它走; 为空说明用户还没填)',
    brandBrief(),
    '',
    '【素材摘要】',
    itemBrief(contentId).slice(0, 1200),
    '',
    '【工作方式】',
    '1. 需要素材细节用 growth_read_material; 需要门店信息用 growth_get_store;',
    '2. 改写一律先用 growth_rewrite_title / growth_rewrite_copy 生成候选, 由用户点选后再 growth_update_output;',
    '3. 配图: 门店实拍图由用户在右侧产出面板点选; 缺图时用 growth_gen_image 生成候选图 —— 提示词由「生图策略」自动按平台比例(小红书/抖音竖版、朋友圈方版) + 画面模板 + 门店招牌菜/禁用词 + 品牌定位与色调拼装, 你只需给画面主体描述(甚至留空), **不要把尺寸/比例/风格长篇写进 prompt**; 需要指定画面类型时传 template(dish/store/cover/people), 需要指定平台时传 platform; 想照着原爆款图生成"我们店的版本"时传 referenceAssetId(结构模板: 只借构图与版式), 有自家实拍图就同时传 contentAssetId(内容以它为准: 菜品/场景不靠编造)(素材本地图的 id 见 growth_read_material 的 assetId 列表), 通道不支持图生图会如实回退纯文本(会在回执里说明)。**「照这条爆款出我们店版本」一律用 referenceAssetId 走图生图, 不要用文字重新描述一遍画面** —— 前者保持构图只换内容, 后者等于重新画; 生成后由用户在右侧点「用这张」选一张; 标题定稿后可用 growth_make_cover 把标题合成到实拍图上做封面(纯本地渲染, 不占生图额度, 模板可选, 传 outputId 则直接顶替该产出的封面);',
    // 联网搜索此前在这里（缺地址/电话先 growth_search_web 查）。该链路已整体下线，
    // 现在缺事实只能追问用户：宁可留占位符，也不要用编造或来路不明的地址电话。
    '4. 缺地址/电话/营业时间等事实: **直接追问用户**, 或用占位符(如【地址】)留着 —— 严禁编造; 用户给的事实用 growth_save_store_fact 写入档案;',
    '5. 门店清单/选品表/排期表/素材台账若在飞书多维表格里: 用 growth_read_lark_base 读(只读; 先不带 table_id 看有哪些表, 再带 table_id 读记录);',
    '6. 每次回复只推进一小步, 用中文简洁说明「做了什么 + 建议下一步」; 不要长篇大论;',
    '7. 涉及对外发布的内容必须过一遍合规: 不用绝对化用语与食品功效宣称。',
    '任务 ID: ' + String(taskId)
  ].join('\n')
}

function historyMessages(sessionId: number): ModelMessage[] {
  const rows = listChatMessages(sessionId)
  const out: ModelMessage[] = []
  for (const r of rows) {
    if (r.kind !== 'text') continue
    const text = (r.content ?? '').trim()
    if (!text) continue
    if (r.role === 'user') out.push({ role: 'user', content: text })
    else if (r.role === 'assistant') out.push({ role: 'assistant', content: text })
  }
  return out.slice(-24)
}

export interface GrowthSendResult {
  ok: boolean
  error?: string
}

/** 发送一条消息并跑完一轮(含工具调用与审批) */
export async function sendGrowthMessage(
  taskId: number,
  text: string,
  images: string[] = []
): Promise<GrowthSendResult> {
  const msg = (text ?? '').trim()
  if (!msg) return { ok: false, error: '消息为空' }
  const task = getTask(taskId)
  if (!task) return { ok: false, error: '任务不存在' }
  const sessionId = task.sessionId
  if (!sessionId) return { ok: false, error: '任务会话缺失, 请删除后重建任务' }
  if (running.has(taskId)) return { ok: false, error: '本轮仍在生成中, 请先停止或等待完成' }

  const cfg = readProviderConfig()
  if (!cfg.enabled || !cfg.apiKey || !cfg.model) {
    const err = 'AI 通道未配置或未启用: 请到 设置 → AI 助手 配置模型后再试。'
    appendChatMessage(sessionId, 'assistant', 'error', err)
    emitWorkbenchEvent(sessionId, { type: 'error', text: err })
    return { ok: false, error: err }
  }

  const ctrl = new AbortController()
  running.set(taskId, ctrl)
  appendChatMessage(sessionId, 'user', 'text', msg)
  emitWorkbenchEvent(sessionId, { type: 'status', text: '生成中' })

  let content = ''
  try {
    const provider = createOpenAICompatible({
      name: 'growth',
      baseURL: cfg.baseUrl,
      apiKey: cfg.apiKey
    })
    const model = provider.chatModel(cfg.model)
    const toolSet = buildGrowthToolSet({
      sessionId,
      taskId,
      contentId: task.contentId,
      storeId: task.storeId
    })

    // 图片输入: 附加到最后一条用户消息(多模态)
    const msgs = historyMessages(sessionId)
    if (images.length > 0 && msgs.length > 0) {
      const last = msgs[msgs.length - 1]
      if (last && last.role === 'user' && typeof last.content === 'string') {
        msgs[msgs.length - 1] = {
          role: 'user',
          content: [
            { type: 'text', text: last.content },
            ...images.slice(0, 3).map((u) => ({ type: 'image' as const, image: u }))
          ] as never
        }
      }
    }

    /** 本轮工具参数暂存：toolCallId → 参数（结果回来时一并落库） */
    const toolArgs = new Map<string, string>()
    let usageIn = 0
    let usageOut = 0
    /** 接口自报的思考 tokens 与结束原因：判断「预算是否被思考吃光」要看它们 */
    let usageReasoning = 0
    let finishReason = ''
    /** 思考过程字数（不上屏，只用于诊断「是不是思考吃光了预算」） */
    let reasoningChars = 0
    let toolRan = false

    const runStream = async (maxTokens: number): Promise<void> => {
      const result = streamText({
        model,
        system: buildGrowthSystem(taskId, task.contentId, task.storeId, task.goal),
        messages: msgs,
        tools: toolSet,
        maxOutputTokens: maxTokens,
        temperature: cfg.temperature,
        abortSignal: ctrl.signal,
        stopWhen: stepCountIs(12)
      })

      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          content += part.text
          emitWorkbenchEvent(sessionId, { type: 'delta', token: part.text })
        } else if (part.type === 'finish') {
          usageIn = part.totalUsage?.inputTokens ?? 0
          usageOut = part.totalUsage?.outputTokens ?? 0
          usageReasoning = part.totalUsage?.outputTokenDetails?.reasoningTokens ?? 0
          finishReason = String(part.finishReason ?? '')
        } else if (part.type === 'reasoning-delta') {
          // 思考过程不上屏（营销场景用户要看的是改稿结论），但长度要留着做诊断
          reasoningChars += (part as { text?: string }).text?.length ?? 0
        } else if (part.type === 'tool-call') {
          toolRan = true
          const args = JSON.stringify(part.input ?? {}).slice(0, 4000)
          // 记下参数：结果回来时要连同参数一起落库（切任务/重开后仍能看到「这一步做了什么」）
          toolArgs.set(part.toolCallId || part.toolName, args)
          emitWorkbenchEvent(sessionId, {
            type: 'tool',
            tool: part.toolName,
            toolStatus: 'start',
            args
          })
        } else if (part.type === 'tool-result') {
          const output = JSON.stringify(part.output ?? '').slice(0, 4000)
          emitWorkbenchEvent(sessionId, {
            type: 'tool',
            tool: part.toolName,
            toolStatus: 'done',
            output
          })
          // 与客服工作台同一口径：一步一行 $kind=tool_call$ 落库（meta 带名字/状态/参数/结果）
          appendChatMessage(sessionId, 'assistant', 'tool_call', '', {
            name: part.toolName,
            status: 'done',
            args: toolArgs.get(part.toolCallId || part.toolName) ?? '',
            output
          })
        } else if (part.type === 'tool-error') {
          const output = String((part.error as Error)?.message ?? part.error ?? '').slice(0, 1000)
          emitWorkbenchEvent(sessionId, {
            type: 'tool',
            tool: part.toolName,
            toolStatus: 'fail',
            output
          })
          appendChatMessage(sessionId, 'assistant', 'tool_call', '', {
            name: part.toolName,
            status: 'fail',
            args: toolArgs.get(part.toolCallId || part.toolName) ?? '',
            output
          })
        } else if (part.type === 'error') {
          throw part.error
        }
      }
    }

    // 预算规划 + 「预算被思考吃光就放大重试」：与客服工作台同一套策略（见 services/ai/outputBudget.ts）
    const budget = planOutputBudget({
      configured: getConfig('ai.maxOutputTokens'),
      fallback: DEFAULT_OUTPUT_TOKENS,
      model: cfg.model
    })
    let usedBudget = budget.maxTokens
    await runStream(usedBudget)
    if (
      !ctrl.signal.aborted &&
      !toolRan &&
      looksBudgetExhausted({
        hasText: content.trim() !== '',
        reasoningChars,
        reasoningTokens: usageReasoning,
        finishReason
      })
    ) {
      const bigger = planOutputBudget({
        configured: getConfig('ai.maxOutputTokens'),
        fallback: DEFAULT_OUTPUT_TOKENS,
        model: cfg.model,
        attempt: 1
      })
      log.warn(
        'task ' +
          String(taskId) +
          ' 输出预算被思考吃光(out=' +
          String(usageOut) +
          ' reasoning=' +
          String(usageReasoning) +
          ')，放大到 ' +
          String(bigger.maxTokens) +
          ' 重试'
      )
      emitWorkbenchEvent(sessionId, {
        type: 'status',
        text: '思考过长已耗尽输出预算，放大到 ' + String(bigger.maxTokens) + ' 重试…'
      })
      try {
        await runStream(bigger.maxTokens)
        usedBudget = bigger.maxTokens
      } catch (e) {
        if (ctrl.signal.aborted) throw e
        // 放大后仍失败：保留下面的诊断（至少能说清是预算问题）
        log.warn('放大预算后仍失败: ' + (e instanceof Error ? e.message : String(e)))
      }
    }

    // 一轮用量落日志（成本排查：营销工作台是"多任务并行"，出账要能对上）
    log.info(
      'task ' +
        String(taskId) +
        ' done tokens(in=' +
        String(usageIn) +
        ' out=' +
        String(usageOut) +
        ' reasoning=' +
        String(usageReasoning) +
        ') budget=' +
        String(usedBudget)
    )

    const trimmed = content.trim()
    if (trimmed) {
      appendChatMessage(sessionId, 'assistant', 'text', trimmed)
      updateTask(taskId, { summary: trimmed.replace(/\s+/g, ' ').slice(0, 80) })
    } else {
      const exhausted = looksBudgetExhausted({
        hasText: false,
        reasoningChars,
        reasoningTokens: usageReasoning,
        finishReason
      })
      appendChatMessage(
        sessionId,
        'assistant',
        'error',
        exhausted
          ? budgetExhaustedMessage({
              maxTokens: usedBudget,
              outputTokens: usageOut,
              reasoningTokens: usageReasoning,
              reasoningChars
            })
          : '模型未返回内容(通道或响应结构异常), 可重试。'
      )
    }
    touchTask(taskId)
    emitWorkbenchEvent(sessionId, { type: 'done' })
    return { ok: true }
  } catch (e) {
    const aborted = ctrl.signal.aborted
    const errMsg = aborted
      ? '已停止生成'
      : describeModelError(e) || (e instanceof Error ? e.message : String(e))
    appendChatMessage(sessionId, 'assistant', aborted ? 'text' : 'error', errMsg)
    emitWorkbenchEvent(sessionId, { type: aborted ? 'status' : 'error', text: errMsg })
    if (!aborted) log.warn('growth turn failed: ' + errMsg)
    return { ok: false, error: errMsg }
  } finally {
    running.delete(taskId)
  }
}

export function stopGrowthChat(taskId: number): void {
  const ctrl = running.get(taskId)
  if (ctrl) ctrl.abort()
}

export function isGrowthRunning(taskId: number): boolean {
  return running.has(taskId)
}
