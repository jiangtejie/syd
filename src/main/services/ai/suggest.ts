import type {
  AiAgent,
  AiGenOptions,
  AiStyle,
  ChatMessage,
  ReplyCandidate
} from '../../../shared/types'
import { createAiProvider, type AiProvider } from './provider'
import { getAgentById, getDefaultAgent } from '../../db/repos/agentRepo'
import { getConfig } from '../../db/repos/config'
import { runSuggestionAgent, toolsInstructionText } from './agentLoop'
import { collectLocalFacts } from './agentTools'
import { memoSystemBlock } from './memo'
import { describeModelError } from './modelErrors'
import { createLogger } from '../logging'

const aiLog = createLogger('ai')

/**
 * AI 建议生成（T7，方案 §4.4）。
 * 输入：会话上下文（最近消息）+ 智能体人设 + 本地事实背景（群问题/团队客服）→ 输出 1~3 条候选。
 *
 * Agent 增强（默认开，ai.agent=0 可关）：
 * - 本地已知背景直接注入（零额外调用）；
 * - 模型认为需要时可用只读工具（读本群问题/搜历史问题/团队名单）再出候选（多一轮往返）；
 * - 工具面全只读、轮数封顶；AI 未启用/未配置 Key/生成失败时不产出候选并返回提示（不返回内置话术）。
 */

/** 风格映射：提示 LLM 的话术要求 */
const STYLE_PROMPT: Record<AiStyle, string> = {
  formal: '语气正式、专业、简洁',
  warm: '语气温暖、亲切、像老练的客服',
  brief: '非常简短，一句到位'
}

/** 最近参与上下文的客户消息数 */
const CONTEXT_TAIL = 30

export function buildContextText(messages: ChatMessage[], sessionName: string): string {
  const tail = messages.slice(-CONTEXT_TAIL)
  const lines = tail.map((m) => {
    const who = m.isSend ? '我方' : m.senderNickname || m.senderUsername || sessionName
    const content = m.parsedContent || m.rawContent
    return `${who}: ${content}`
  })
  return lines.join('\n')
}

/** 输出协议（必须严格遵守，防止非法 JSON 破坏候选解析） */
const OUTPUT_PROTOCOL = [
  '要求：',
  '1. 只输出 JSON 数组，形如 [{"text": "回复内容"}]，不要输出任何其他文字或 Markdown 代码块；',
  '2. 生成 1~3 条候选回复，作为不同语气/侧重的选择；',
  '3. 回复要符合企业客服规范，不承诺法律/资金类内容，不确定的引导转人工。'
].join('\n')

/** 按智能体组装系统提示词：人设由 名称+角色设定+自定义守则+风格 动态生成 */
function buildSystemForAgent(agent: AiAgent): string {
  return [
    `你是一名${agent.name}，正在协助真人客服为个人微信好友撰写回复。`,
    agent.description ? `角色设定：${agent.description}` : '',
    agent.prompt ? `工作守则（务必遵守）：${agent.prompt}` : '',
    `话术风格：${STYLE_PROMPT[agent.style ?? 'warm']}`,
    OUTPUT_PROTOCOL
  ]
    .filter((x) => x !== '')
    .join('\n')
}

const SYSTEM_PROMPT = `你是一名微信私域智能客服，正在协助真人客服为个人微信好友撰写回复。\n${OUTPUT_PROTOCOL}`

function parseCandidates(raw: string): ReplyCandidate[] | null {
  const trimmed = raw.trim()
  const json = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
    : trimmed
  try {
    const arr = JSON.parse(json) as Array<{ text?: string }>
    if (!Array.isArray(arr)) return null
    const out = arr
      .filter((x) => typeof x.text === 'string' && x.text.trim().length > 0)
      .slice(0, 3)
      .map((x) => ({ text: x.text!.trim(), source: 'ai_free' as const }))
    return out.length > 0 ? out : null
  } catch {
    return null
  }
}

/** 组装用户提示词（会话对象 + 本地事实背景 + 聊天记录 + 输出要求） */
function buildUserPrompt(
  sessionName: string,
  messages: ChatMessage[],
  style: AiStyle,
  agent: AiAgent | undefined,
  facts: string,
  withTools: boolean
): string {
  const context = buildContextText(messages, sessionName)
  const parts = [
    `会话对象：${sessionName}`,
    agent ? '' : `话术风格：${STYLE_PROMPT[style]}`,
    facts ? `本地已知背景（已为你查好，无需重复调用工具）：\n${facts}` : '',
    '以下是最近聊天记录（我方为客服方；群里「我方同事」的发言也是我方人员，不应视为客户诉求）：',
    '```',
    context,
    '```',
    '请基于最后一条客户消息生成回复候选。',
    withTools
      ? '若背景或聊天记录不足以判断（例如需要查该客户/该群历史问题），可先请求工具：\n' +
        toolsInstructionText()
      : '直接输出候选 JSON 数组。'
  ]
  return parts.filter((x) => x !== '').join('\n')
}

export async function generateSuggestions(
  wxid: string,
  sessionId: string,
  sessionName: string,
  messages: ChatMessage[],
  opts: AiGenOptions = {}
): Promise<{ candidates: ReplyCandidate[]; llm: boolean; error?: string; toolsUsed?: string[] }> {
  const style = opts.style ?? 'warm'
  // 智能体解析：指定 id → 无效回退默认；未指定也使用默认（人设应全局生效）
  const agent = (opts.agentId ? getAgentById(opts.agentId) : undefined) ?? getDefaultAgent()

  // AI 通道未启用 / 未配置 Key / 配置异常 → 不产出任何候选（无内置话术），由 UI 引导配置
  let provider: AiProvider | null = null
  try {
    provider = createAiProvider('suggest')
  } catch (e) {
    aiLog.warn(`provider config error: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!provider) {
    return {
      candidates: [],
      llm: false,
      error: 'AI 通道未就绪：未启用，或未配置 API Key / 模型名（设置 → AI 助手 完善后重试）'
    }
  }
  if (messages.length === 0) {
    return { candidates: [], llm: false }
  }

  const system = agent ? buildSystemForAgent(agent) : SYSTEM_PROMPT
  const memoBlock = memoSystemBlock(900)
  const finalSystem = memoBlock ? `${system}\n\n${memoBlock}` : system
  const agentEnabled = getConfig('ai.agent') !== '0'
  // 本地已知背景（零 LLM 成本：群 open 问题 + 团队客服名单）
  const facts = agentEnabled ? collectLocalFacts({ wxid, sessionId }) : ''
  const userPrompt = buildUserPrompt(sessionName, messages, style, agent, facts, agentEnabled)

  if (!agentEnabled) {
    try {
      const raw = await provider.complete(finalSystem, userPrompt, { maxTokens: 1024 })
      const ai = parseCandidates(raw)
      if (ai && ai.length > 0) return { candidates: ai, llm: true }
      return { candidates: [], llm: true, error: 'AI 未返回有效候选，请点击重新生成或稍后重试' }
    } catch (e) {
      aiLog.error('llm generate failed', e)
      const detail = describeModelError(e) || (e instanceof Error ? e.message : String(e))
      return { candidates: [], llm: false, error: `AI 生成失败：${detail}` }
    }
  }

  // Agent 增强：可选只读工具轮
  try {
    const run = await runSuggestionAgent({
      ctx: { wxid, sessionId },
      system: finalSystem,
      userPrompt,
      complete: (s, u, o) => provider.complete(s, u, o),
      onEvent: (evt) => aiLog.debug(`agent tool: ${evt.name}`)
    })
    const ai = parseCandidates(run.text)
    if (ai && ai.length > 0) {
      return { candidates: ai, llm: true, toolsUsed: run.toolsUsed }
    }
    return {
      candidates: [],
      llm: true,
      error: 'AI 未返回有效候选，请点击重新生成或稍后重试'
    }
  } catch (e) {
    aiLog.error('agent generate failed', e)
    const detail = describeModelError(e) || (e instanceof Error ? e.message : String(e))
    return { candidates: [], llm: false, error: `AI 生成失败：${detail}` }
  }
}
