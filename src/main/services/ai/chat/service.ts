import { BrowserWindow } from 'electron'
import { createAiProvider, readProviderConfig, type ToolSchema, type WireMsg } from '../provider'
import { getConfig } from '../../../db/repos/config'
import { getAgentById, getDefaultAgent } from '../../../db/repos/agentRepo'
import { getDb } from '../../../db/database'
import {
  appendChatMessage,
  clearChatMessages,
  createChat,
  lastUserMessage,
  listChatMessages,
  listChats,
  removeChat,
  renameChat,
  setChatAgent,
  touchChat
} from '../../../db/repos/chatRepo'
import {
  ALL_TOOLS,
  findTool,
  schemaFromParams,
  toolInstructionsText,
  type ToolCtx,
  type ToolDef
} from './skills'
import { findMcpTool, mcpToolInstructionText, mcpToolNames } from './mcp'
import { customToolInstructionText, findCustomTool, listCustomToolDefs } from './customTools'
import type { AiChatEvent, AiStyle, ChatMsgItem, ChatTurn } from '../../../../shared/types'

/**
 * AI 助手会话 Runner(docs/ai-assistant-design.md §5/6/7)。
 * 单条发送流程:追加用户消息 → 上下文构建(人设 system + 历史裁剪) →
 *   (工具意图判定:JSON 工具请求,最多 4 轮,逐轮本地/MCP 执行并回填) → 最终正文流式输出。
 * 事件统一 webContents.send('ai:chat', AiChatEvent);runId 确认机制服务高危工具。
 */

const MAX_TOOL_ROUNDS = 4
const HISTORY_MAX_ROWS = 40
/** 上下文字符预算(约等于主流 8K 上下文的 2/3,防长会话爆窗) */
const CONTEXT_CHAR_BUDGET = 48_000
/** 单条消息最长保留字符(超长截断并加尾注) */
const MAX_MSG_CHARS = 6000
const SYSTEM_FALLBACK =
  '你是「微信私域智能客服」桌面助手。回答要简洁、结构清晰、用中文;基于事实,不确定时明确说明。'

const STYLE_DESC: Record<AiStyle, string> = {
  warm: '语气温暖亲切,像熟悉店铺的客服',
  formal: '语气正式专业',
  brief: '语气简洁干练,少客套'
}

/** 人设 + 内置 skill + 自定义工具 + MCP 工具的 system 组装(async:MCP 需惰性握手) */
async function buildSystem(agentId?: string | null): Promise<string> {
  const base = agentSystemText(agentId)
  let mcpText = ''
  try {
    mcpText = await mcpToolInstructionText()
  } catch {
    /* MCP 不可用不阻塞对话 */
  }
  const sections = [toolInstructionsText(), customToolInstructionText(), mcpText].filter(
    (s) => s.trim().length > 0
  )
  if (sections.length === 0) return `${base}\n\n直接回答用户问题。`
  return [
    base,
    '可用工具(仅当需要业务数据时调用;工具请求必须是独立 JSON,不要夹带其它文字):',
    sections.join('\n\n'),
    '如果不需要工具,直接输出最终回答。'
  ].join('\n\n')
}

function agentSystemText(agentId: string | null | undefined): string {
  const agent = agentId ? getAgentById(agentId) : getDefaultAgent()
  if (!agent) return SYSTEM_FALLBACK
  const parts: string[] = []
  if (agent.prompt) parts.push(agent.prompt)
  parts.push(
    `你是「${agent.name}」客服智能体${agent.description ? `,角色定位:${agent.description}` : ''}。${STYLE_DESC[agent.style ?? 'warm']}`
  )
  parts.push('回答要基于事实;不确定时明确说明,不编造。')
  return parts.join('\n')
}

function sendEvent(wxid: string, evt: Omit<AiChatEvent, 'wxid'> & { wxid?: string }): void {
  const payload: AiChatEvent = { wxid, ...evt } as AiChatEvent
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('ai:chat', payload)
  }
}

/** 运行句柄:中断控制器 + 是否仍在跑 */
interface RunHandle {
  controller: AbortController
  active: boolean
  wxid: string
  chatId: number
}
const running = new Map<string, RunHandle>()
const runKeyOf = (wxid: string, chatId: number): string => `${wxid}|${chatId}`

/** 高危工具人工确认:runId → resolve;超时按取消处理 */
const pendingConfirm = new Map<string, { resolve: (v: boolean) => void; timer: NodeJS.Timeout }>()
let confirmSeq = 0

/** 从判定文本中提取 ReAct 显式思考(「思考:」行或 JSON 内 thought 字段) */
function extractThought(text: string): string | undefined {
  const m = /^\s*(?:\[思考\]|思考|Thought|Reasoning)[：:]\s*(.{1,120})$/m.exec(text)
  if (m?.[1]?.trim()) return m[1].trim()
  try {
    const j = JSON.parse(text) as { thought?: unknown }
    if (typeof j?.thought === 'string' && j.thought.trim()) return j.thought.trim().slice(0, 120)
  } catch {
    /* ignore */
  }
  return undefined
}

/** 从模型文本中识别工具 JSON 请求;非 JSON/非 tool 返回 null(视为正文) */
function parseToolIntent(text: string): { tool: string; args: Record<string, unknown> } | null {
  let t = text.trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t)
  if (fence) t = fence[1].trim()
  try {
    const obj = JSON.parse(t) as { tool?: unknown; args?: unknown }
    if (typeof obj?.tool === 'string' && obj.tool.trim()) {
      const args =
        obj.args && typeof obj.args === 'object' && !Array.isArray(obj.args)
          ? (obj.args as Record<string, unknown>)
          : {}
      return { tool: obj.tool.trim(), args }
    }
  } catch {
    /* 走正则兜底 */
  }
  const m = /^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/.exec(t)
  if (m) {
    try {
      const obj = JSON.parse(m[1]) as { tool?: unknown; args?: unknown }
      if (typeof obj?.tool === 'string' && obj.tool.trim()) {
        return {
          tool: obj.tool.trim(),
          args:
            obj.args && typeof obj.args === 'object' && !Array.isArray(obj.args)
              ? (obj.args as Record<string, unknown>)
              : {}
        }
      }
    } catch {
      /* ignore */
    }
  }
  return null
}

/** 历史消息 → LLM turns(工具结果以 user 角色回填;tool_call 行仅 UI 用,不入上下文) */
function historyToTurns(rows: ChatMsgItem[]): ChatTurn[] {
  const turns: ChatTurn[] = []
  for (const r of rows) {
    if (r.kind === 'error' || r.kind === 'tool_call') continue
    if (r.kind === 'tool_result') {
      turns.push({ role: 'user', content: `[工具结果]\n${r.content}` })
      continue
    }
    if (r.role === 'user' || r.role === 'assistant') {
      turns.push({ role: r.role, content: r.content })
    }
  }
  // 单条截断 + 总量预算:保留最新,超限从最旧丢弃
  const kept: ChatTurn[] = []
  let sum = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]
    const content =
      t.content.length > MAX_MSG_CHARS
        ? `${t.content.slice(0, MAX_MSG_CHARS)}\n…(超长已截断)`
        : t.content
    if (kept.length > 0 && sum + content.length > CONTEXT_CHAR_BUDGET) break
    kept.unshift({ role: t.role, content })
    sum += content.length
  }
  // 条数上限兜底(预算未触发时)
  return kept.length > HISTORY_MAX_ROWS ? kept.slice(kept.length - HISTORY_MAX_ROWS) : kept
}

async function runTurn(opts: {
  wxid: string
  sessionId: number
  agentId?: string | null
  userText: string
  appendUserRow: boolean
}): Promise<void> {
  const { wxid, sessionId, userText } = opts
  const provider = createAiProvider()
  if (!provider) {
    const msg = 'AI 通道未配置或未启用:请到 设置 → AI 通道 配置模型后再试。'
    sendEvent(wxid, { type: 'error', chatId: sessionId, text: msg })
    appendChatMessage(sessionId, 'assistant', 'error', msg)
    return
  }
  const key = runKeyOf(wxid, sessionId)
  if (running.get(key)?.active) {
    sendEvent(wxid, { type: 'error', chatId: sessionId, text: '该会话正在生成中,请等待或先停止。' })
    return
  }
  const handle: RunHandle = {
    controller: new AbortController(),
    active: true,
    wxid,
    chatId: sessionId
  }
  running.set(key, handle)
  const signal = handle.controller.signal
  try {
    if (opts.appendUserRow) appendChatMessage(sessionId, 'user', 'text', userText)
    const agentId = opts.agentId ?? undefined
    const system = await buildSystem(agentId)

    const turns = historyToTurns(listChatMessages(sessionId))
    turns.push({ role: 'user', content: userText })

    // token 用量累计(决策轮 + 工具轮 + 终文)
    let totalIn = 0
    let totalOut = 0
    const addUsage = (u: { inputTokens?: number; outputTokens?: number } | undefined): void => {
      if (!u) return
      totalIn += u.inputTokens ?? 0
      totalOut += u.outputTokens ?? 0
    }

    // 工具轮:最多 4 轮(小预算静默调用,逐字交给最终轮)
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (signal.aborted) break
      let decision = ''
      const decide = await provider.streamChat([{ role: 'system', content: system }, ...turns], {
        maxTokens: 800,
        signal,
        onDelta: (t) => {
          decision += t
        }
      })
      addUsage(decide.usage)
      const thought = extractThought(decision)
      const intent = parseToolIntent(decision)
      if (!intent) break
      const def = findTool(intent.tool) ?? findMcpTool(intent.tool) ?? findCustomTool(intent.tool)
      if (!def) {
        // 未知工具:回填可用列表让模型修正
        const names = [
          ...ALL_TOOLS.map((t) => t.name),
          ...mcpToolNames(),
          ...listCustomToolDefs().map((t) => t.name)
        ]
        const err = `工具 ${intent.tool} 不存在。可用工具:${names.join('、')}`
        appendChatMessage(sessionId, 'user', 'tool_result', err)
        turns.push({
          role: 'user',
          content: `[工具结果]\n${err}\n(请修正后重试或换用其它工具,或直接输出最终回答)`
        })
        continue
      }
      const argsClip = JSON.stringify(intent.args ?? {}).slice(0, 300)
      sendEvent(wxid, {
        type: 'tool',
        chatId: sessionId,
        tool: def.name,
        toolStatus: 'start',
        args: argsClip,
        thought
      })

      // 高危工具:渲染端人工确认(60s 超时按取消)
      if (def.confirm) {
        const runId = `c${++confirmSeq}`
        const confirmed = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => {
            pendingConfirm.delete(runId)
            resolve(false)
          }, 60_000)
          pendingConfirm.set(runId, { resolve, timer })
          sendEvent(wxid, {
            type: 'tool',
            chatId: sessionId,
            tool: def.name,
            toolStatus: 'pending',
            args: argsClip,
            text: runId
          })
        })
        if (!confirmed) {
          const msg = `工具 ${def.name} 未获确认,已跳过。`
          appendChatMessage(sessionId, 'user', 'tool_result', msg)
          turns.push({ role: 'user', content: `[工具结果]\n${msg}` })
          sendEvent(wxid, {
            type: 'tool',
            chatId: sessionId,
            tool: def.name,
            toolStatus: 'fail',
            resultClip: msg
          })
          continue
        }
      }

      const ctx: ToolCtx = { wxid }
      const result = await def.run(ctx, intent.args)
      appendChatMessage(sessionId, 'assistant', 'tool_call', JSON.stringify(intent.args), {
        tool: def.name
      })
      appendChatMessage(sessionId, 'user', 'tool_result', result, { tool: def.name })
      // ReAct 观察引导:先判断结果,再决定 继续/换工具/修正参数/直接回答
      turns.push({
        role: 'user',
        content: `[工具结果]\n${result}\n(先判断该结果是否足以回答:不足则继续调用(可先给「思考:」)、换工具或修正参数;已足够则直接输出最终回答。)`
      })
      sendEvent(wxid, {
        type: 'tool',
        chatId: sessionId,
        tool: def.name,
        toolStatus: 'done',
        resultClip: result.slice(0, 500)
      })
      if (round === MAX_TOOL_ROUNDS - 1) break
    }

    // 最终正文:流式输出
    if (signal.aborted) return
    let content = ''
    let finalReasoning: string | undefined
    sendEvent(wxid, { type: 'status', chatId: sessionId, text: '生成中' })
    try {
      const finalRes = await provider.streamChat([{ role: 'system', content: system }, ...turns], {
        maxTokens: 2400,
        signal,
        onDelta: (t) => {
          content += t
          sendEvent(wxid, { type: 'delta', chatId: sessionId, token: t })
        }
      })
      addUsage(finalRes.usage)
      finalReasoning = finalRes.reasoningText
    } catch (e) {
      const aborted = signal.aborted || (e instanceof Error && e.name === 'AbortError')
      if (aborted) {
        if (content.trim()) {
          appendChatMessage(sessionId, 'assistant', 'text', content)
          sendEvent(wxid, { type: 'done', chatId: sessionId, messageId: 0 })
        }
        sendEvent(wxid, { type: 'status', chatId: sessionId, text: '已停止' })
        return
      }
      throw e
    }
    const trimmed = content.trim()
    if (!trimmed) {
      const msg = '模型未返回内容(可能是思考型模型预算不足),可重试或调大模型输出预算。'
      appendChatMessage(sessionId, 'assistant', 'error', msg)
      sendEvent(wxid, { type: 'error', chatId: sessionId, text: msg })
      return
    }
    const meta: Record<string, unknown> = {}
    if (totalIn || totalOut) meta.tokens = { input: totalIn, output: totalOut }
    if (finalReasoning && finalReasoning.trim()) meta.reasoning = finalReasoning.trim().slice(-600)
    const messageId = appendChatMessage(sessionId, 'assistant', 'text', trimmed, meta)
    touchChat(sessionId)
    sendEvent(wxid, { type: 'done', chatId: sessionId, messageId })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    appendChatMessage(sessionId, 'assistant', 'error', msg)
    sendEvent(wxid, { type: 'error', chatId: sessionId, text: msg })
  } finally {
    handle.active = false
    running.delete(key)
  }
}

// ── 双协议:原生 function-calling 通道(自动回退 JSON 协议) ──

/** 模型是否走原生 tools:reasoner/思考型默认 JSON 协议;可用配置 ai.nativeTools='0' 强制关闭 */
function shouldUseNativeTools(): boolean {
  if (getConfig('ai.nativeTools') === '0') return false
  const model = readProviderConfig().model.toLowerCase() || ''
  if (!model) return false
  if (
    /(reasoner|deepseek-r1|r1-|o1|o3|mini-max.*think|qwen.*think|glm.*think|thinking)/i.test(model)
  ) {
    return false
  }
  return true
}

/** 原生轮 system:保留能力说明,但禁止文本 JSON 工具请求(工具由原生机制提供) */
function nativeSystemText(base: string): string {
  return `${base}\n\n工作方式:调用工具前先在内心想清楚“是否需要数据/如何调用”,逐步推进;工具结果返回后先判断是否足够,再决定继续调用或输出最终回答。工具由系统原生提供,不要输出 JSON 格式的工具请求。`
}

/** 工具参数 schema:有 params 声明生成精确 schema,否则宽松 object */
function schemaOf(tool: {
  name: string
  description?: string
  params?: ToolDef['params']
}): ToolSchema {
  return {
    name: tool.name,
    description: tool.description ?? '',
    parameters: schemaFromParams(tool.params)
  }
}

function isToolCapabilityError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e)
  return /tool|function|parameters/i.test(m)
}

/** 原生工具轮执行(与 JSON 协议同一套 def/确认/落库/事件) */
async function executeNativeToolCalls(opts: {
  wxid: string
  sessionId: number
  calls: Array<{ id?: string; name: string; arguments: string }>
  wire: WireMsg[]
}): Promise<void> {
  const { wxid, sessionId, calls, wire } = opts
  const wireCalls: WireMsg[] = [
    {
      role: 'assistant',
      content: null,
      tool_calls: calls.map((c, i) => ({
        id: c.id ?? `tc_${i}`,
        type: 'function' as const,
        function: { name: c.name, arguments: c.arguments }
      }))
    }
  ]
  wire.push(...wireCalls)
  for (const call of calls) {
    const def = findTool(call.name) ?? findMcpTool(call.name) ?? findCustomTool(call.name)
    const argsClip = call.arguments.slice(0, 300)
    sendEvent(wxid, {
      type: 'tool',
      chatId: sessionId,
      tool: call.name,
      toolStatus: 'start',
      args: argsClip
    })
    if (!def) {
      const names = [
        ...ALL_TOOLS.map((t) => t.name),
        ...mcpToolNames(),
        ...listCustomToolDefs().map((t) => t.name)
      ]
      const err = `工具 ${call.name} 不存在。可用工具:${names.join('、')}`
      appendChatMessage(sessionId, 'user', 'tool_result', err, { tool: call.name })
      wire.push({ role: 'tool', tool_call_id: call.id ?? `tc_0`, content: err })
      sendEvent(wxid, {
        type: 'tool',
        chatId: sessionId,
        tool: call.name,
        toolStatus: 'fail',
        resultClip: err
      })
      continue
    }
    if (def.confirm) {
      const runId = `n${++confirmSeq}`
      const ok = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          pendingConfirm.delete(runId)
          resolve(false)
        }, 60_000)
        pendingConfirm.set(runId, { resolve, timer })
        sendEvent(wxid, {
          type: 'tool',
          chatId: sessionId,
          tool: def.name,
          toolStatus: 'pending',
          args: argsClip,
          text: runId
        })
      })
      if (!ok) {
        const msg = `工具 ${def.name} 未获确认,已跳过。`
        appendChatMessage(sessionId, 'user', 'tool_result', msg, { tool: def.name })
        wire.push({ role: 'tool', tool_call_id: call.id ?? `tc_0`, content: msg })
        sendEvent(wxid, {
          type: 'tool',
          chatId: sessionId,
          tool: def.name,
          toolStatus: 'fail',
          resultClip: msg
        })
        continue
      }
    }
    let args: Record<string, unknown> = {}
    try {
      args = JSON.parse(call.arguments || '{}') as Record<string, unknown>
      if (!args || typeof args !== 'object' || Array.isArray(args)) args = {}
    } catch {
      args = {}
    }
    const result = await def
      .run({ wxid }, args)
      .catch((e: unknown) => `工具执行失败:${e instanceof Error ? e.message : String(e)}`)
    appendChatMessage(sessionId, 'assistant', 'tool_call', call.arguments, { tool: call.name })
    appendChatMessage(sessionId, 'user', 'tool_result', result, { tool: call.name })
    wire.push({ role: 'tool', tool_call_id: call.id ?? `tc_0`, content: result })
    sendEvent(wxid, {
      type: 'tool',
      chatId: sessionId,
      tool: def.name,
      toolStatus: 'done',
      resultClip: result.slice(0, 500)
    })
  }
}

/** 原生 function-calling 路径:模型原生请求工具→执行→续轮,直到纯文本(≤4 轮);失败自动降级 JSON 协议 */
async function runTurnNative(opts: {
  wxid: string
  sessionId: number
  agentId?: string | null
  userText: string
  appendUserRow: boolean
}): Promise<void> {
  const { wxid, sessionId, userText } = opts
  const provider = createAiProvider()
  if (!provider) return
  const key = runKeyOf(wxid, sessionId)
  const handle: RunHandle = {
    controller: new AbortController(),
    active: true,
    wxid,
    chatId: sessionId
  }
  running.set(key, handle)
  const signal = handle.controller.signal
  try {
    if (opts.appendUserRow) appendChatMessage(sessionId, 'user', 'text', userText)
    const agentId = opts.agentId ?? undefined
    const system = nativeSystemText(agentSystemText(agentId))
    const schemas = [
      ...ALL_TOOLS,
      ...listCustomToolDefs(),
      // MCP 工具已就绪时才纳入(由 buildSystem 预握手触发)
      ...mcpToolNames().map((n) => findMcpTool(n)!)
    ].map(schemaOf)

    const wire: WireMsg[] = [{ role: 'system', content: system }]
    for (const t of historyToTurns(listChatMessages(sessionId))) {
      wire.push({ role: t.role, content: t.content })
    }
    wire.push({ role: 'user', content: userText })

    let totalIn = 0
    let totalOut = 0
    let reasoningText = ''
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (signal.aborted) return
      sendEvent(wxid, {
        type: 'status',
        chatId: sessionId,
        text: round === 0 ? '生成中' : '工具处理中'
      })
      const res = await provider.streamChatTools(wire, schemas, { maxTokens: 2400, signal })
      if (res.usage) {
        totalIn += res.usage.inputTokens ?? 0
        totalOut += res.usage.outputTokens ?? 0
      }
      if (res.reasoningText) reasoningText = res.reasoningText
      if (!res.toolCalls || res.toolCalls.length === 0) {
        // 终文:整段输出(原生轮不做打字机回放)
        const trimmed = res.text.trim()
        if (!trimmed) {
          const msg = '模型未返回内容(可能是思考型模型预算不足),可重试。'
          appendChatMessage(sessionId, 'assistant', 'error', msg)
          sendEvent(wxid, { type: 'error', chatId: sessionId, text: msg })
          return
        }
        const meta: Record<string, unknown> = {}
        if (totalIn || totalOut) meta.tokens = { input: totalIn, output: totalOut }
        if (reasoningText.trim()) meta.reasoning = reasoningText.trim().slice(-600)
        const messageId = appendChatMessage(sessionId, 'assistant', 'text', trimmed, meta)
        touchChat(sessionId)
        sendEvent(wxid, { type: 'done', chatId: sessionId, messageId })
        return
      }
      await executeNativeToolCalls({ wxid, sessionId, calls: res.toolCalls, wire })
    }
    const msg = '工具轮数超限仍未完成。'
    appendChatMessage(sessionId, 'assistant', 'error', msg)
    sendEvent(wxid, { type: 'error', chatId: sessionId, text: msg })
  } catch (e) {
    const aborted = signal.aborted || (e instanceof Error && e.name === 'AbortError')
    if (aborted) {
      sendEvent(wxid, { type: 'status', chatId: sessionId, text: '已停止' })
      return
    }
    if (isToolCapabilityError(e)) {
      // 通道不支持 tools → 自动降级 JSON 协议重跑(用户消息已落库,不再追加)
      await runTurn({
        wxid,
        sessionId,
        agentId: opts.agentId ?? undefined,
        userText,
        appendUserRow: false
      })
      return
    }
    const msg = e instanceof Error ? e.message : String(e)
    appendChatMessage(sessionId, 'assistant', 'error', msg)
    sendEvent(wxid, { type: 'error', chatId: sessionId, text: msg })
  } finally {
    handle.active = false
    running.delete(key)
  }
}

/** 入口分发:支持原生 tools 的模型走原生通道,否则 JSON 协议 */
function dispatchTurn(opts: {
  wxid: string
  sessionId: number
  agentId?: string | null
  userText: string
  appendUserRow: boolean
}): void {
  if (shouldUseNativeTools()) {
    void runTurnNative(opts)
  } else {
    void runTurn(opts)
  }
}

export interface SendChatResult {
  ok: boolean
  chatId?: number
  error?: string
}

/** 发送一条消息;chatId 为空则先建会话(标题=首条消息) */
export async function sendChatMessage(input: {
  wxid: string
  chatId?: number
  agentId?: string | null
  text: string
}): Promise<SendChatResult> {
  const text = (input.text || '').trim()
  if (!text) return { ok: false, error: '消息为空' }
  if (!(input.wxid || '').trim()) return { ok: false, error: '缺少账号标识' }
  let sessionId = input.chatId
  if (!sessionId) {
    sessionId = createChat(input.wxid, text.slice(0, 24) || '新对话', input.agentId)
  }
  void dispatchTurn({
    wxid: input.wxid,
    sessionId,
    agentId: input.agentId,
    userText: text,
    appendUserRow: true
  })
  return { ok: true, chatId: sessionId }
}

/** 停止某会话生成 */
export function stopChat(wxid: string, chatId: number): void {
  const handle = running.get(runKeyOf(wxid, chatId))
  if (handle?.active) handle.controller.abort()
}

/** 按会话 id 中止其运行(删除/清空会话前调用,防孤儿任务继续写已删会话) */
export function stopChatById(chatId: number): void {
  for (const handle of running.values()) {
    if (handle.chatId === chatId && handle.active) handle.controller.abort()
  }
}

/** 重试:移除失败的尾部 assistant/error 行,重跑最后一次 user 消息 */
export async function retryChat(
  wxid: string,
  chatId: number,
  agentId?: string | null
): Promise<SendChatResult> {
  const rows = listChatMessages(chatId)
  // 去掉尾部 assistant(error/空)或未完成的 tool 轮残留
  while (rows.length > 0) {
    const last = rows[rows.length - 1]
    if (last.role === 'assistant' || last.kind === 'tool_call' || last.kind === 'tool_result') {
      // 直接重建:清空后重放全部历史代价高;此处删除最后几类行改用 DB 清理辅助函数
      clearLastMessage(chatId)
      rows.pop()
      continue
    }
    break
  }
  const userText = lastUserMessage(chatId)
  if (!userText) return { ok: false, error: '没有可重试的消息' }
  void dispatchTurn({
    wxid,
    sessionId: chatId,
    agentId: agentId ?? undefined,
    userText,
    appendUserRow: false
  })
  return { ok: true, chatId }
}

function clearLastMessage(sessionId: number): void {
  getDb()
    .prepare(
      `DELETE FROM chat_message WHERE id = (SELECT MAX(id) FROM chat_message WHERE session_id = ?)`
    )
    .run(sessionId)
}

/** 清空会话消息(保留会话) */
export function clearChat(sessionId: number): void {
  clearChatMessages(sessionId)
}

/** 确认高危工具 */
export function confirmToolRun(runId: string, ok: boolean): boolean {
  const entry = pendingConfirm.get(runId)
  if (!entry) return false
  clearTimeout(entry.timer)
  pendingConfirm.delete(runId)
  entry.resolve(ok)
  return true
}

export const chatRepo = { listChats, renameChat, removeChat, setChatAgent }
export type { ToolCtx }
