import { BrowserWindow } from 'electron'
import { createAiProvider } from '../provider'
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
import { ALL_TOOLS, findTool, toolInstructionsText, type ToolCtx } from './skills'
import { findMcpTool, mcpToolInstructionText, mcpToolNames } from './mcp'
import type { AiChatEvent, AiStyle, ChatMsgItem, ChatTurn } from '../../../../shared/types'

/**
 * AI 助手会话 Runner(docs/ai-assistant-design.md §5/6/7)。
 * 单条发送流程:追加用户消息 → 上下文构建(人设 system + 历史裁剪) →
 *   (工具意图判定:JSON 工具请求,最多 4 轮,逐轮本地/MCP 执行并回填) → 最终正文流式输出。
 * 事件统一 webContents.send('ai:chat', AiChatEvent);runId 确认机制服务高危工具。
 */

const MAX_TOOL_ROUNDS = 4
const HISTORY_MAX_ROWS = 40
const SYSTEM_FALLBACK =
  '你是「微信私域智能客服」桌面助手。回答要简洁、结构清晰、用中文;基于事实,不确定时明确说明。'

const STYLE_DESC: Record<AiStyle, string> = {
  warm: '语气温暖亲切,像熟悉店铺的客服',
  formal: '语气正式专业',
  brief: '语气简洁干练,少客套'
}

/** 人设 + 内置 skill + MCP 工具的 system 组装(async:MCP 需惰性握手) */
async function buildSystem(agentId?: string | null): Promise<string> {
  const base = agentSystemText(agentId)
  let mcpText = ''
  try {
    mcpText = await mcpToolInstructionText()
  } catch {
    /* MCP 不可用不阻塞对话 */
  }
  const builtinText = toolInstructionsText()
  const sections = [builtinText, mcpText].filter((s) => s.trim().length > 0)
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

/** 历史消息 → LLM turns(工具结果以 user 角色回填,保持上下文一致) */
function historyToTurns(rows: ChatMsgItem[]): ChatTurn[] {
  const turns: ChatTurn[] = []
  for (const r of rows) {
    if (r.kind === 'error') continue
    if (r.kind === 'tool_result') {
      turns.push({ role: 'user', content: `[工具结果]\n${r.content}` })
      continue
    }
    if (r.role === 'user' || r.role === 'assistant') {
      turns.push({ role: r.role, content: r.content })
    }
  }
  // 窗口裁剪:保留最近 HISTORY_MAX_ROWS 条(不含 system)
  return turns.length > HISTORY_MAX_ROWS ? turns.slice(turns.length - HISTORY_MAX_ROWS) : turns
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

    // 工具轮:最多 4 轮(小预算静默调用,逐字交给最终轮)
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (signal.aborted) break
      let decision = ''
      await provider.streamChat([{ role: 'system', content: system }, ...turns], {
        maxTokens: 300,
        signal,
        onDelta: (t) => {
          decision += t
        }
      })
      const intent = parseToolIntent(decision)
      if (!intent) break
      const def = findTool(intent.tool) ?? findMcpTool(intent.tool)
      if (!def) {
        // 未知工具:回填可用列表让模型修正
        const names = [...ALL_TOOLS.map((t) => t.name), ...mcpToolNames()]
        const err = `工具 ${intent.tool} 不存在。可用工具:${names.join('、')}`
        appendChatMessage(sessionId, 'user', 'tool_result', err)
        turns.push({ role: 'user', content: `[工具结果]\n${err}` })
        continue
      }
      const argsClip = JSON.stringify(intent.args ?? {}).slice(0, 300)
      sendEvent(wxid, {
        type: 'tool',
        chatId: sessionId,
        tool: def.name,
        toolStatus: 'start',
        args: argsClip
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
      turns.push({ role: 'user', content: `[工具结果]\n${result}` })
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
    sendEvent(wxid, { type: 'status', chatId: sessionId, text: '生成中' })
    try {
      await provider.streamChat([{ role: 'system', content: system }, ...turns], {
        maxTokens: 2400,
        signal,
        onDelta: (t) => {
          content += t
          sendEvent(wxid, { type: 'delta', chatId: sessionId, token: t })
        }
      })
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
    const messageId = appendChatMessage(sessionId, 'assistant', 'text', trimmed)
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
  let sessionId = input.chatId
  if (!sessionId) {
    sessionId = createChat(input.wxid, text.slice(0, 24) || '新对话', input.agentId)
  }
  void runTurn({
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
  void runTurn({
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
