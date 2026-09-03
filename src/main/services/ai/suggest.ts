import type {
  AiAgent,
  AiGenOptions,
  AiStyle,
  ChatMessage,
  ReplyCandidate
} from '../../../shared/types'
import { createAiProvider, type AiProvider } from './provider'
import { buildTemplateCandidates } from './templates'
import { getAgentById, getDefaultAgent } from '../../db/repos/agentRepo'

/**
 * AI 建议生成（T7，方案 §4.4）。
 * 输入：会话上下文（最近消息）→ 输出 1~3 条候选（kb_direct / ai_free）。
 * 流程：模板命中优先 → LLM 生成 → 兜底话术，逐级降级，永不抛错。
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

/** 取最近一条客户（非我方）消息文本，用于模板命中 */
function lastCustomerText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m.isSend && (m.parsedContent || m.rawContent)) return m.parsedContent || m.rawContent
  }
  return ''
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
  const lastText = lastCustomerText(messages)

  // 1) 模板命中优先（kb_direct，M1 阶段主要产出）
  if (lastText) {
    const tpl = buildTemplateCandidates(lastText)
    // 敏感词/售后类模板直接采用，不做 AI 二次生成
    if (tpl[0]?.reason?.includes('转人工') || tpl[0]?.reason?.includes('敏感')) {
      return { candidates: tpl, llm: false }
    }
  }

  // 2) LLM 生成（仅当配置了 provider 且消息不为空）
  let provider: AiProvider | null = null
  try {
    provider = createAiProvider()
  } catch (e) {
    console.warn('[ai] provider config error', e)
  }
  if (provider && messages.length > 0) {
    try {
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
      const raw = await provider.complete(system, userPrompt, { maxTokens: 500 })
      const ai = parseCandidates(raw)
      if (ai && ai.length > 0) return { candidates: ai, llm: true }
    } catch (e) {
      console.warn('[ai] llm generate failed, fallback to templates', e)
    }
  }

  // 3) 模板/兜底话术
  const tpl = lastText ? buildTemplateCandidates(lastText) : buildTemplateCandidates('')
  return { candidates: tpl, llm: false }
}
