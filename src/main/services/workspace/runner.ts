import { BrowserWindow } from 'electron'
import { createAiProvider } from '../ai/provider'
import type { AiChatEvent, ChatMsgItem, ChatTurn } from '../../../shared/types'
import {
  appendWorkspaceMessage,
  getWorkspaceSession,
  listWorkspaceMessages,
  popLastWorkspaceMessage,
  lastWorkspaceUserText,
  touchWorkspaceSession
} from '../../db/repos/workspaceRepo'
import {
  WORKSPACE_TOOLS_TEXT,
  buildTree,
  loadProjectContext,
  toolEditFile,
  toolGlob,
  toolGrep,
  toolListDir,
  toolReadFile,
  toolRunCommand,
  toolWriteFile
} from './tools'

/**
 * 工作区 Agent runner(本地自动化副驾 v1;Claude Code 风格,JSON 文本工具协议)。
 * - 每会话绑定一个工作目录;system = 人设/边界 + 项目上下文(CLAUDE.md/AGENTS.md/README+目录树);
 * - 决策轮(≤6 轮):「思考:」+ JSON {"tool","args"} → 执行 → [工具结果] 回填,最终轮流式正文;
 * - 写/执行类工具走人工确认(pending 事件 → cs:workspace:confirm),60s 未确认视为拒绝;
 * - 事件统一 webContents.send('ai:ws', AiChatEvent & {sessionId});会话数据独立于客服 AI 会话。
 */

const MAX_TOOL_ROUNDS = 6
const MAX_HISTORY_CHARS = 24_000
const MAX_MSG_CHARS = 6000
const CONFIRM_TIMEOUT_MS = 60_000

interface RunHandle {
  controller: AbortController
  active: boolean
  sessionId: number
}

const running = new Map<number, RunHandle>()
const pendingConfirm = new Map<
  string,
  { sessionId: number; resolve: (v: boolean) => void; timer: NodeJS.Timeout }
>()
let confirmSeq = 0

export interface WorkspaceSendResult {
  ok: boolean
  error?: string
}

function sendEvent(sessionId: number, evt: Omit<AiChatEvent, 'wxid'> & { wxid?: string }): void {
  const payload = { wxid: '', sessionId, ...evt } as AiChatEvent & { sessionId: number }
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('ai:ws', payload)
  }
}

function isRunning(sessionId: number): boolean {
  return !!running.get(sessionId)?.active
}

/** 确认闸门:只读直跑;confirm 类挂 pending 等待 UI(60s 超时=拒绝) */
async function gateConfirm(
  sessionId: number,
  toolName: string,
  run: () => Promise<string>
): Promise<string> {
  const runId = `w${++confirmSeq}`
  const ok = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pendingConfirm.delete(runId)
      resolve(false)
    }, CONFIRM_TIMEOUT_MS)
    pendingConfirm.set(runId, { sessionId, resolve, timer })
    sendEvent(sessionId, {
      type: 'tool',
      chatId: sessionId,
      tool: toolName,
      toolStatus: 'pending',
      args: '',
      text: runId
    })
  })
  if (!ok) return `工具 ${toolName} 未获确认(超时或被拒绝),已跳过。请说明用途后由用户允许重试。`
  return await run()
}

export function confirmWorkspaceTool(runId: string, ok: boolean): boolean {
  const entry = pendingConfirm.get(runId)
  if (!entry) return false
  clearTimeout(entry.timer)
  pendingConfirm.delete(runId)
  entry.resolve(ok)
  return true
}

const CONFIRM_TOOLS = new Set(['write_file', 'edit_file', 'run_command'])

async function execTool(
  sessionId: number,
  cwd: string,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const safe = async (run: () => Promise<string>): Promise<string> => {
    if (CONFIRM_TOOLS.has(name)) return await gateConfirm(sessionId, name, run)
    try {
      return await run()
    } catch (e) {
      return `工具执行失败:${e instanceof Error ? e.message : String(e)}`
    }
  }
  try {
    switch (name) {
      case 'read_file':
        return await safe(() => toolReadFile(cwd, args))
      case 'list_dir':
        return await safe(() => toolListDir(cwd, args))
      case 'glob':
        return await safe(() => toolGlob(cwd, args))
      case 'grep':
        return await safe(() => toolGrep(cwd, args))
      case 'write_file':
        return await safe(() => toolWriteFile(cwd, args))
      case 'edit_file':
        return await safe(() => toolEditFile(cwd, args))
      case 'run_command':
        return await safe(() => toolRunCommand(cwd, args))
      default:
        return `未知工具:${name}。可用:${WORKSPACE_TOOLS_TEXT.split('\n')
          .slice(1)
          .map((l) => l.split('(')[0].trim())
          .filter(Boolean)
          .join('、')}`
    }
  } catch (e) {
    return `工具执行失败:${e instanceof Error ? e.message : String(e)}`
  }
}

function historyToTurns(rows: ChatMsgItem[]): ChatTurn[] {
  const turns: ChatTurn[] = []
  for (const r of rows) {
    if (r.kind === 'error' || r.kind === 'tool_call') continue
    if (r.kind === 'tool_result') {
      turns.push({ role: 'user', content: `[工具结果]\n${r.content}` })
      continue
    }
    if (r.role === 'user' || r.role === 'assistant')
      turns.push({ role: r.role, content: r.content })
  }
  const kept: ChatTurn[] = []
  let sum = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]
    const content =
      t.content.length > MAX_MSG_CHARS
        ? `${t.content.slice(0, MAX_MSG_CHARS)}\n…(超长已截断)`
        : t.content
    if (kept.length > 0 && sum + content.length > MAX_HISTORY_CHARS) break
    kept.unshift({ role: t.role, content })
    sum += content.length
  }
  return kept.slice(-40)
}

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
    /* 非 JSON → 正文 */
  }
  return null
}

const SYSTEM_TEMPLATE = `你是「工作区助手」:运行在本地桌面软件里的自动化 agent(Claude Code 风格),替用户在选定工作目录内读代码、查资料、改文件、跑命令。
硬性边界(必须遵守):
1. 所有路径操作仅限工作区内:${'__CWD__'};写文件/编辑/执行命令每次会弹人工确认,60 秒未确认即被拒绝;
2. 只读操作(read_file/list_dir/glob/grep)可直接调用,不要请求确认、不要编造文件内容;
3. 需要给用户看的正文要简洁中文,说明做了什么/结果如何;大段原文用工具读而不是贴进正文;
4. 用户要求“保存/导出/产出文件”时使用 write_file(会确认),不要仅把内容写在回复里;
5. 不确定时如实说明,不臆测文件内容与命令结果。
工具(思考+JSON 协议):需要工具时先输出一行「思考:」(≤80 字),随后单独输出 JSON:{"tool":"工具名","args":{...}};结果会以 [工具结果] 回填,足够后直接输出最终回答,不要夹带 JSON。
${WORKSPACE_TOOLS_TEXT}

# 项目上下文(只读,自动注入)
__CONTEXT__`

export function workspacePromptStatus(cwd: string, title: string): string {
  return `工作区:${title}(${cwd})`
}

async function buildSystem(cwd: string): Promise<string> {
  const context = await loadProjectContext(cwd)
  return SYSTEM_TEMPLATE.replace('__CWD__', cwd).replace('__CONTEXT__', context)
}

/** 发送一条消息;同会话 busy 时拒绝 */
export async function sendWorkspaceMessage(
  sessionId: number,
  text: string
): Promise<WorkspaceSendResult> {
  const msg = (text || '').trim()
  if (!msg) return { ok: false, error: '消息为空' }
  const session = getWorkspaceSession(sessionId)
  if (!session) return { ok: false, error: '会话不存在' }
  if (isRunning(sessionId)) return { ok: false, error: '正在处理中,请等待或先停止' }

  const provider = createAiProvider()
  if (!provider) {
    const err = 'AI 通道未配置或未启用:请到 设置 → AI 通道 配置模型后再试。'
    appendWorkspaceMessage(sessionId, 'assistant', 'error', err)
    sendEvent(sessionId, { type: 'error', chatId: sessionId, text: err })
    return { ok: false, error: err }
  }

  appendWorkspaceMessage(sessionId, 'user', 'text', msg)
  const handle: RunHandle = { controller: new AbortController(), active: true, sessionId }
  running.set(sessionId, handle)
  const signal = handle.controller.signal
  try {
    const rows = listWorkspaceMessages(sessionId)
    const system = await buildSystem(session.cwd)
    const turns = historyToTurns(rows)
    turns.push({ role: 'user', content: msg })

    let totalIn = 0
    let totalOut = 0
    const addUsage = (u: { inputTokens?: number; outputTokens?: number } | undefined): void => {
      if (!u) return
      totalIn += u.inputTokens ?? 0
      totalOut += u.outputTokens ?? 0
    }

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (signal.aborted) return { ok: true }
      let decision = ''
      const decide = await provider.streamChat([{ role: 'system', content: system }, ...turns], {
        maxTokens: 800,
        signal,
        onDelta: (t) => {
          decision += t
        }
      })
      addUsage(decide.usage)
      const intent = parseToolIntent(decision)
      if (!intent) break
      const argsClip = JSON.stringify(intent.args ?? {}).slice(0, 300)
      sendEvent(sessionId, {
        type: 'tool',
        chatId: sessionId,
        tool: intent.tool,
        toolStatus: 'start',
        args: argsClip
      })
      const result = await execTool(sessionId, session.cwd, intent.tool, intent.args ?? {})
      appendWorkspaceMessage(
        sessionId,
        'assistant',
        'tool_call',
        JSON.stringify(intent.args ?? {}),
        { tool: intent.tool }
      )
      appendWorkspaceMessage(sessionId, 'user', 'tool_result', result, { tool: intent.tool })
      turns.push({
        role: 'user',
        content: `[工具结果]\n${result}\n(先判断是否足够:不足可继续调用/换工具/修正参数;足够则直接输出最终回答,不要输出 JSON)`
      })
      sendEvent(sessionId, {
        type: 'tool',
        chatId: sessionId,
        tool: intent.tool,
        toolStatus: 'done',
        resultClip: result.slice(0, 500)
      })
    }

    if (signal.aborted) return { ok: true }
    sendEvent(sessionId, { type: 'status', chatId: sessionId, text: '生成中' })
    let content = ''
    const finalRes = await provider.streamChat([{ role: 'system', content: system }, ...turns], {
      maxTokens: 2400,
      signal,
      onDelta: (t) => {
        content += t
        sendEvent(sessionId, { type: 'delta', chatId: sessionId, token: t })
      }
    })
    addUsage(finalRes.usage)
    const trimmed = content.trim()
    if (!trimmed) {
      const err = '模型未返回内容(预算或通道问题),可重试。'
      appendWorkspaceMessage(sessionId, 'assistant', 'error', err)
      sendEvent(sessionId, { type: 'error', chatId: sessionId, text: err })
      return { ok: true }
    }
    const meta: Record<string, unknown> = {}
    if (totalIn || totalOut) meta.tokens = { input: totalIn, output: totalOut }
    if (finalRes.reasoningText?.trim()) meta.reasoning = finalRes.reasoningText.trim().slice(-600)
    const messageId = appendWorkspaceMessage(sessionId, 'assistant', 'text', trimmed, meta)
    touchWorkspaceSession(sessionId)
    sendEvent(sessionId, { type: 'done', chatId: sessionId, messageId })
    return { ok: true }
  } catch (e) {
    const aborted = signal.aborted || (e instanceof Error && e.name === 'AbortError')
    if (aborted) {
      sendEvent(sessionId, { type: 'status', chatId: sessionId, text: '已停止' })
      return { ok: true }
    }
    const msg = e instanceof Error ? e.message : String(e)
    appendWorkspaceMessage(sessionId, 'assistant', 'error', msg)
    sendEvent(sessionId, { type: 'error', chatId: sessionId, text: msg })
    return { ok: true }
  } finally {
    handle.active = false
    running.delete(sessionId)
  }
}

export function stopWorkspaceChat(sessionId: number): void {
  const handle = running.get(sessionId)
  if (handle?.active) handle.controller.abort()
}

/** 重试:清掉尾部失败/工具残留,重跑最后一条用户消息 */
export async function retryWorkspaceMessage(sessionId: number): Promise<WorkspaceSendResult> {
  const session = getWorkspaceSession(sessionId)
  if (!session) return { ok: false, error: '会话不存在' }
  if (isRunning(sessionId)) return { ok: false, error: '正在处理中' }
  const rows = listWorkspaceMessages(sessionId)
  while (rows.length > 0) {
    const last = rows[rows.length - 1]
    if (last.role === 'assistant' || last.kind === 'tool_call' || last.kind === 'tool_result') {
      popLastWorkspaceMessage(sessionId)
      rows.pop()
      continue
    }
    break
  }
  const text = lastWorkspaceUserText(sessionId)
  if (!text) return { ok: false, error: '没有可重试的消息' }
  return await sendWorkspaceMessage(sessionId, text)
}

export { buildTree }
