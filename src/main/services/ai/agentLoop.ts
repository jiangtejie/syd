import { runSuggestionTool, toolsInstructionText, type AgentToolCtx } from './agentTools'

/**
 * 迷你自研 Agent 循环（方案 A）。
 * 协议：首轮允许模型输出 JSON {"tool":"<name>","args":{...}} 请求只读工具；
 * 执行工具后携带结果进行下一轮，要求输出最终候选。模型直接给最终候选则零额外往返。
 * 安全：工具面全只读；轮数/工具次数封顶；解析失败按最终文本交给上层降级（永不抛错由上层兜底）。
 */

export interface AgentRunResult {
  /** 最终模型文本（交给上层解析候选） */
  text: string
  /** 实际 LLM 调用轮数 */
  rounds: number
  /** 已执行工具名（供审计/日志） */
  toolsUsed: string[]
}

interface CompleteFn {
  (system: string, user: string, opts?: { maxTokens?: number }): Promise<string>
}

export interface SuggestionAgentOptions {
  ctx: AgentToolCtx
  system: string
  /** 已含候选输出协议与工具说明的提示词（suggest 负责拼装） */
  userPrompt: string
  complete: CompleteFn
  maxRounds?: number
  maxToolCalls?: number
  onEvent?: (evt: { kind: 'tool'; name: string }) => void
}

/** 从模型输出中识别意图：tool 请求 / 数组候选 / 其它文本 */
function parseAgentIntent(
  raw: string
):
  | { kind: 'tool'; name: string; args: Record<string, unknown> }
  | { kind: 'array' }
  | { kind: 'other' } {
  const trimmed = raw.trim()
  const json = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
    : trimmed
  // 1) 完整 JSON
  try {
    const obj: unknown = JSON.parse(json)
    return classify(obj)
  } catch {
    /* 继续正则尝试 */
  }
  // 2) 掐头去尾（模型偶发加注释/换行）
  const objMatch = /^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/.exec(json)
  if (objMatch) {
    try {
      return classify(JSON.parse(objMatch[1]))
    } catch {
      /* ignore */
    }
  }
  const arrMatch = /^[\s\S]*?(\[[\s\S]*\])[\s\S]*$/.exec(json)
  if (arrMatch) {
    try {
      return classify(JSON.parse(arrMatch[1]))
    } catch {
      /* ignore */
    }
  }
  return { kind: 'other' }
}

function classify(
  obj: unknown
):
  | { kind: 'tool'; name: string; args: Record<string, unknown> }
  | { kind: 'array' }
  | { kind: 'other' } {
  if (Array.isArray(obj)) return { kind: 'array' }
  if (obj && typeof obj === 'object') {
    const name = (obj as { tool?: unknown; tool_name?: unknown }).tool
    if (typeof name === 'string' && name.length > 0) {
      const argsObj = (obj as { args?: unknown }).args
      const args: Record<string, unknown> =
        argsObj && typeof argsObj === 'object' && !Array.isArray(argsObj)
          ? (argsObj as Record<string, unknown>)
          : {}
      return { kind: 'tool', name, args }
    }
  }
  return { kind: 'other' }
}

export async function runSuggestionAgent(opts: SuggestionAgentOptions): Promise<AgentRunResult> {
  const maxRounds = Math.min(Math.max(opts.maxRounds ?? 3, 1), 4)
  const maxToolCalls = Math.min(Math.max(opts.maxToolCalls ?? 2, 1), 3)
  const toolsUsed: string[] = []

  let text = await opts.complete(opts.system, opts.userPrompt, { maxTokens: 1024 })
  let rounds = 1
  while (rounds < maxRounds) {
    const intent = parseAgentIntent(text)
    if (intent.kind !== 'tool') break
    if (toolsUsed.length >= maxToolCalls) break
    toolsUsed.push(intent.name)
    opts.onEvent?.({ kind: 'tool', name: intent.name })
    const result = await runSuggestionTool(opts.ctx, intent.name, intent.args)
    rounds++
    text = await opts.complete(
      opts.system,
      `${opts.userPrompt}\n\n工具 ${intent.name} 返回：\n${result}\n\n请基于工具结果直接输出最终候选 JSON 数组（不要再请求工具）。`,
      { maxTokens: 1024 }
    )
  }
  return { text, rounds, toolsUsed }
}

/** 供 suggest 复用的工具说明（仅当启用 Agent 增强时追加到用户提示词） */
export { toolsInstructionText }
