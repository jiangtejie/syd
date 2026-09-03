import type {
  AiAgent,
  AiGenOptions,
  AiStyle,
  ChatMessage,
  ReplyCandidate
} from '../../../shared/types'
import { createAiProvider, type AiProvider } from './provider'
import { getAgentById, getDefaultAgent } from '../../db/repos/agentRepo'

/**
 * AI 建议生成（T7，方案 §4.4）。
 * 输入：会话上下文（最近消息）→ 输出 1~3 条候选（ai_free，由 LLM 通道生成）。
 * 仅依赖 LLM：AI 未启用 / 未配置 Key / 生成失败时不产出任何候选，返回提示由 UI 引导，
 * 不再返回内置固定话术（原 kb_direct 示例模板与兜底底稿已随「去除模拟数据」移除，
 * 真实知识库命中待 knowledge_item 接入后另行实现）。
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
    const who = m.isSend ? '我方' : m.senderUsername === sessionName ? '客户' : m.senderUsername
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

export async function generateSuggestions(
  sessionName: string,
  messages: ChatMessage[],
  opts: AiGenOptions = {}
): Promise<{ candidates: ReplyCandidate[]; llm: boolean; error?: string }> {
  const style = opts.style ?? 'warm'
  // 智能体解析：指定 id → 无效回退默认；未指定也使用默认（人设应全局生效）
  const agent = (opts.agentId ? getAgentById(opts.agentId) : undefined) ?? getDefaultAgent()

  // AI 通道未启用 / 未配置 Key / 配置异常 → 不产出任何候选（无内置话术），由 UI 引导配置
  let provider: AiProvider | null = null
  try {
    provider = createAiProvider()
  } catch (e) {
    console.warn('[ai] provider config error', e)
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

  const context = buildContextText(messages, sessionName)
  // agent 已带风格时不再重复注入风格行
  const userPrompt = [
    `会话对象：${sessionName}`,
    agent ? '' : `话术风格：${STYLE_PROMPT[style]}`,
    '以下是最近聊天记录（我方为客服方）：',
    '```',
    context,
    '```',
    '请基于最后一条客户消息生成回复候选，输出 JSON 数组。'
  ]
    .filter((x) => x !== '')
    .join('\n')
  const system = agent ? buildSystemForAgent(agent) : SYSTEM_PROMPT
  try {
    const raw = await provider.complete(system, userPrompt, { maxTokens: 500 })
    const ai = parseCandidates(raw)
    if (ai && ai.length > 0) return { candidates: ai, llm: true }
    return { candidates: [], llm: true, error: 'AI 未返回有效候选，请点击重新生成或稍后重试' }
  } catch (e) {
    console.warn('[ai] llm generate failed', e)
    const detail = e instanceof Error ? e.message : String(e)
    return { candidates: [], llm: false, error: `AI 生成失败：${detail}` }
  }
}
