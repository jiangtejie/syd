/**
 * 营销 AI 工作台对话引擎: 复用与客服工作台同一套 AI SDK 通道/事件通道/审批桥,
 * 但注入营销域 system(门店事实卡 + 素材拆解 + 目标)与营销工具组。
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { stepCountIs, streamText, type ModelMessage } from 'ai'
import { appendChatMessage, listChatMessages } from '../../../db/repos/chatRepo'
import { getTask, touchTask, updateTask } from '../../../db/repos/growthAiRepo'
import { readProviderConfig } from '../../ai/provider'
import { describeModelError } from '../../ai/modelErrors'
import { emitWorkbenchEvent } from '../../ai/workbench/events'
import { buildGrowthToolSet, itemBrief, storeBrief } from './growthTools'
import { createLogger } from '../../logging'

const log = createLogger('growth-ai')

const running = new Map<number, AbortController>()

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
    '【素材摘要】',
    itemBrief(contentId).slice(0, 1200),
    '',
    '【工作方式】',
    '1. 需要素材细节用 growth_read_material; 需要门店信息用 growth_get_store;',
    '2. 改写一律先用 growth_rewrite_title / growth_rewrite_copy 生成候选, 由用户点选后再 growth_update_output;',
    '3. 换图: 门店实拍图由用户在右侧产出面板点选; 模型可用 growth_gen_image 生成候选图(会标注示意图), 或用 growth_replace_image 换成联网图(需确认版权);',
    '4. 缺地址/电话/营业时间等事实: 先 growth_search_web 查, 让用户确认后再 growth_save_store_fact 写入档案;',
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
    const result = streamText({
      model,
      system: buildGrowthSystem(taskId, task.contentId, task.storeId, task.goal),
      messages: msgs,
      tools: toolSet,
      maxOutputTokens: 3000,
      temperature: cfg.temperature,
      abortSignal: ctrl.signal,
      stopWhen: stepCountIs(12)
    })

    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        content += part.text
        emitWorkbenchEvent(sessionId, { type: 'delta', token: part.text })
      } else if (part.type === 'tool-call') {
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

    const trimmed = content.trim()
    if (trimmed) {
      appendChatMessage(sessionId, 'assistant', 'text', trimmed)
      updateTask(taskId, { summary: trimmed.replace(/\s+/g, ' ').slice(0, 80) })
    } else {
      appendChatMessage(sessionId, 'assistant', 'error', '模型未返回内容(预算或通道问题), 可重试。')
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
