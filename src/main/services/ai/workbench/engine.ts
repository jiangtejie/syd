import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { generateText, stepCountIs, streamText, type ModelMessage } from 'ai'
import { readProviderConfig } from '../provider'
import { getConfig } from '../../../db/repos/config'
import {
  appendChatMessage,
  lastUserMessage,
  listChatMessages,
  popLastChatMessage,
  touchChat
} from '../../../db/repos/chatRepo'
import { buildWorkbenchSystem } from './context'
import { buildWorkbenchToolSet } from './tools'
import { emitWorkbenchEvent } from './events'

/**
 * 工作台引擎(AI SDK 原生工具循环;不自研 loop/协议/流式)。
 * - model = openai-compatible(沿用 ai.baseUrl/model/key 配置);
 * - tools = 产品原生只读能力(见 tools.ts);确认桥 v1 无写工具,为 v2 预留;
 * - 会话复用 chat_session/chat_message;事件通道 ai:wb;AbortController 停止;
 * - 上下文预算:历史 ≤40 条 / ≤24k 字符 / 单条 6k,超限用 generateText 压缩旧段。
 */

const MAX_ROWS = 40
const MAX_CHARS = 24_000
const MAX_MSG_CHARS = 6000
const COMPRESS_THRESHOLD_ROWS = 24
const COMPRESS_THRESHOLD_CHARS = 36_000
/** 推理过程(思考内容)实时上屏上限:超限后不再推送/落库,避免消息体过大 */
const REASON_CAP = 6000
/** 工具调用参数/结果推送到渲染端的上限(渲染端可折叠查看,截断防刷屏) */
const TOOL_IO_CAP = 4000

/** 工具参数/结果 → 可推送文本(≤TOOL_IO_CAP,带截断标记) */
function clipToolIO(v: unknown): { text: string; truncated: boolean } {
  let text: string
  if (v === null || v === undefined) {
    text = ''
  } else if (typeof v === 'string') {
    text = v.trim()
  } else {
    try {
      text = JSON.stringify(v, null, 2)
    } catch {
      text = String(v)
    }
  }
  if (text.length <= TOOL_IO_CAP) return { text, truncated: false }
  return { text: `${text.slice(0, TOOL_IO_CAP)}\n…(已截断,原 ${text.length} 字)`, truncated: true }
}

/** 剔除控制字符/零宽字符,避免干扰 markdown 解析与复制 */
function cleanModelText(s: string): string {
  /* eslint-disable no-control-regex -- 有意清理模型输出中的控制字符 */
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
  /* eslint-enable no-control-regex */
}

interface RunHandle {
  controller: AbortController
  active: boolean
}

const running = new Map<number, RunHandle>()

export interface WbSendResult {
  ok: boolean
  error?: string
}

type WbModel = ReturnType<ReturnType<typeof createOpenAICompatible>['chatModel']>

function reasonerModel(model: string): boolean {
  return /(reasoner|deepseek-r1|r1-|o1|o3|think|thinking)/i.test(model)
}

/** 历史 → SDK messages(仅 user/assistant 文本;工具行由 SDK 自动重建) */
function historyToMessages(
  rows: Array<{ role: string; kind: string; content: string }>
): ModelMessage[] {
  const turns: ModelMessage[] = []
  for (const r of rows) {
    if (r.kind === 'tool_call' || r.kind === 'tool_result' || r.kind === 'error') continue
    if (r.role === 'user') {
      turns.push({ role: 'user', content: r.content } as ModelMessage)
    } else if (r.role === 'assistant') {
      turns.push({ role: 'assistant', content: r.content } as ModelMessage)
    }
  }
  const kept: ModelMessage[] = []
  let sum = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]
    const text = typeof t.content === 'string' ? t.content : ''
    const content =
      text.length > MAX_MSG_CHARS ? `${text.slice(0, MAX_MSG_CHARS)}\n…(超长已截断)` : text
    if (kept.length > 0 && sum + content.length > MAX_CHARS) break
    kept.unshift({ role: t.role, content } as ModelMessage)
    sum += content.length
  }
  return kept.slice(-MAX_ROWS)
}

/** 长会话压缩旧段(失败降级丢弃旧段,不阻塞会话) */
async function compressHistory(
  model: WbModel,
  rows: Array<{ role: string; kind: string; content: string }>
): Promise<string | null> {
  const keep = Math.ceil(rows.length / 2)
  const old = rows.slice(0, rows.length - keep)
  const text = old
    .map((r) => `${r.role === 'user' ? '用户' : '助手'}: ${r.content.slice(0, 400)}`)
    .join('\n')
    .slice(-24_000)
  try {
    const res = await generateText({
      model,
      maxOutputTokens: 600,
      system:
        '你是对话摘要器。把客服工作台历史对话压缩为不超过 400 字的中文摘要:保留已查到的业务结论与数据要点、客户诉求与状态、待办。不要复述寒暄。',
      prompt: `历史对话:\n${text}`
    })
    return res.text.trim().slice(0, 1400) || null
  } catch {
    return null
  }
}

/** 发送一条工作台消息;wxid 为会话绑定的微信账号(未绑定传空串) */
export async function sendWorkbenchMessage(
  sessionId: number,
  wxid: string,
  text: string
): Promise<WbSendResult> {
  const msg = (text || '').trim()
  if (!msg) return { ok: false, error: '消息为空' }
  if (running.get(sessionId)?.active) {
    return { ok: false, error: '正在处理中,请等待或先停止' }
  }
  const cfg = readProviderConfig()
  if (!cfg.enabled || !cfg.apiKey || !cfg.model) {
    const err = 'AI 通道未配置或未启用:请到 设置 → AI 助手 配置模型后再试。'
    appendChatMessage(sessionId, 'assistant', 'error', err)
    emitWorkbenchEvent(sessionId, { type: 'error', text: err })
    return { ok: false, error: err }
  }
  if (reasonerModel(cfg.model) && getConfig('wb.allowReasoner') !== '1') {
    const err =
      '当前模型疑似思考型(工具调用支持不稳定)。请到 设置 → AI 助手 换用非思考模型,或设置 wb.allowReasoner=1 强制尝试。'
    appendChatMessage(sessionId, 'assistant', 'error', err)
    emitWorkbenchEvent(sessionId, { type: 'error', text: err })
    return { ok: false, error: err }
  }

  const provider = createOpenAICompatible({
    name: 'wechat-cs-workbench',
    apiKey: cfg.apiKey,
    baseURL: cfg.baseUrl
  })
  const model = provider.chatModel(cfg.model)
  const boundWxid = (wxid || '').trim()

  appendChatMessage(sessionId, 'user', 'text', msg)
  const handle: RunHandle = { controller: new AbortController(), active: true }
  running.set(sessionId, handle)
  const signal = handle.controller.signal

  try {
    let rows = listChatMessages(sessionId).map((r) => ({
      role: r.role,
      kind: r.kind,
      content: r.content
    }))
    let summary: string | null = null
    const chars = rows.reduce((n, r) => n + r.content.length, 0)
    if (rows.length >= COMPRESS_THRESHOLD_ROWS && chars > COMPRESS_THRESHOLD_CHARS) {
      summary = await compressHistory(model, rows)
      rows = rows.slice(rows.length - Math.ceil(rows.length / 2))
    }
    const messages: ModelMessage[] = historyToMessages(rows)
    const system = buildWorkbenchSystem(boundWxid, { summary })
    const toolSet = buildWorkbenchToolSet(boundWxid, sessionId)

    emitWorkbenchEvent(sessionId, { type: 'status', text: '生成中' })
    let content = ''
    let reasoning = ''
    let reasonStartedAt = 0
    let reasonEndedAt = 0
    let usageIn = 0
    let usageOut = 0
    const result = streamText({
      model,
      system,
      messages,
      tools: toolSet,
      maxOutputTokens: 2400,
      temperature: cfg.temperature,
      abortSignal: signal,
      stopWhen: stepCountIs(10)
    })

    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        content += part.text
        emitWorkbenchEvent(sessionId, { type: 'delta', token: part.text })
      } else if (part.type === 'reasoning-delta') {
        // 思考型模型(reasoner)的推理过程:实时推送,收尾随 meta.reasoning 落库
        const t = cleanModelText((part as { text?: string }).text ?? '')
        if (t) {
          const now = Date.now()
          if (reasonStartedAt === 0) reasonStartedAt = now
          reasonEndedAt = now
          const room = REASON_CAP - reasoning.length
          if (room > 0) {
            const chunk = room >= t.length ? t : t.slice(0, room)
            reasoning += chunk
            emitWorkbenchEvent(sessionId, { type: 'reasoning', token: chunk })
          }
        }
      } else if (part.type === 'tool-call') {
        const io = clipToolIO((part as { input?: unknown }).input)
        emitWorkbenchEvent(sessionId, {
          type: 'tool',
          tool: part.toolName,
          toolStatus: 'start',
          args: io.text
        })
      } else if (part.type === 'tool-result') {
        const io = clipToolIO((part as { output?: unknown }).output)
        emitWorkbenchEvent(sessionId, {
          type: 'tool',
          tool: part.toolName,
          toolStatus: 'done',
          output: io.text,
          outTrunc: io.truncated
        })
      } else if (part.type === 'tool-error') {
        const msg =
          part.error instanceof Error ? part.error.message : String(part.error ?? '').trim()
        emitWorkbenchEvent(sessionId, {
          type: 'tool',
          tool: part.toolName,
          toolStatus: 'fail',
          output: msg.slice(0, TOOL_IO_CAP) || '工具执行失败(无详情)',
          outTrunc: msg.length > TOOL_IO_CAP
        })
      } else if (part.type === 'error') {
        throw part.error
      } else if (part.type === 'finish') {
        usageIn = part.totalUsage?.inputTokens ?? 0
        usageOut = part.totalUsage?.outputTokens ?? 0
      }
    }

    if (signal.aborted) {
      emitWorkbenchEvent(sessionId, { type: 'status', text: '已停止' })
      return { ok: true }
    }
    const trimmed = cleanModelText(content).trim()
    if (!trimmed) {
      const err = '模型未返回内容(预算或通道问题),可重试。'
      appendChatMessage(sessionId, 'assistant', 'error', err)
      emitWorkbenchEvent(sessionId, { type: 'error', text: err })
      return { ok: true }
    }
    const meta: Record<string, unknown> = {}
    if (usageIn || usageOut) meta.tokens = { input: usageIn, output: usageOut }
    if (reasoning.trim()) {
      meta.reasoning = reasoning.trim()
      if (reasonStartedAt > 0) {
        meta.reasoningMs = Math.max(0, (reasonEndedAt || Date.now()) - reasonStartedAt)
      }
    }
    const messageId = appendChatMessage(sessionId, 'assistant', 'text', trimmed, meta)
    touchChat(sessionId)
    emitWorkbenchEvent(sessionId, { type: 'done', messageId })
    return { ok: true }
  } catch (e) {
    const aborted = signal.aborted || (e instanceof Error && e.name === 'AbortError')
    if (aborted) {
      emitWorkbenchEvent(sessionId, { type: 'status', text: '已停止' })
      return { ok: true }
    }
    const errMsg = e instanceof Error ? e.message : String(e)
    appendChatMessage(sessionId, 'assistant', 'error', errMsg)
    emitWorkbenchEvent(sessionId, { type: 'error', text: errMsg })
    return { ok: true }
  } finally {
    handle.active = false
    running.delete(sessionId)
  }
}

export function stopWorkbenchChat(sessionId: number): void {
  running.get(sessionId)?.controller.abort()
}

/** 重试:清除尾部 assistant 行后重发最后一条用户消息 */
export async function retryWorkbenchMessage(
  sessionId: number,
  wxid: string
): Promise<WbSendResult> {
  if (running.get(sessionId)?.active) return { ok: false, error: '正在处理中' }
  const rows = listChatMessages(sessionId)
  while (rows.length > 0) {
    const last = rows[rows.length - 1]
    if (last.role === 'assistant') {
      popLastChatMessage(sessionId)
      rows.pop()
      continue
    }
    break
  }
  const text = lastUserMessage(sessionId)
  if (!text) return { ok: false, error: '没有可重试的消息' }
  return await sendWorkbenchMessage(sessionId, wxid, text)
}
