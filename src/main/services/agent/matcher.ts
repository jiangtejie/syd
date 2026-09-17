import type { ReplyScript } from '../../db/repos/replyScriptRepo'
import { isAckOnly, isTransactionalNotice } from '../feedback/textFilters'

/**
 * 话术匹配（纯函数，可自检）。
 *
 * 数字员工「该不该回、按哪条话术回」的全部判定都在这里，不碰 IO —— 便于用真实消息回放校准。
 * 判定顺序（先否决后命中，越靠前越便宜）：
 *   L0 不介入：我方/团队已发言、机器读不懂（图片/视频/没转写的语音）、纯应答、事务性通知、内容过短
 *   L1 命中话术：按 priority 升序取第一条命中（关键词 / 正则）
 *      - 风险 C（价格红线/退款/投诉）→ handoff：永不自动发
 *      - 风险 B（价格/优惠/账期等需人看的）→ confirm：**必须人工确认后才发**
 *      - 风险 A → reply：可自动发
 *   L2 未命中：交给 LLM 兜底（产出仍需过风险闸门）
 *
 * 为什么 B 必须是独立 action：以前 B 与 A 返回同一个 'reply'，风险分级只是 reason 里的一句
 * 文本，判定层不做任何拦截。二期接 live 的人只要按 action==='reply' 发，价格/账期类话术
 * 就会跟 A 类一起静默发出去 —— 那是直接的钱的损失，不能靠「记得别发」这种约定兜着。
 */

/** L0 不介入的原因（写进 agent_reply.reason，影子复盘时一眼能看出「为什么没回」） */
export type SkipReason = 'from-team' | 'non-text' | 'ack-only' | 'notice' | 'too-short' | 'empty'

export interface MatchInput {
  /** 客户消息文本（已去控制字符） */
  text: string
  /** 我方/团队发言：数字员工不介入（已有归属判定给出这个信号） */
  fromTeam?: boolean
  /** 非文本消息（[图片]/[语音]/[文件] 等占位） */
  nonText?: boolean
  /** 模板变量：客户名/群名/日期 等 */
  vars?: Record<string, string>
}

export type MatchResult =
  | { action: 'skip'; skipReason: SkipReason; reason: string }
  /** 风险 A：可直接发 */
  | { action: 'reply'; script: ReplyScript; replyText: string; reason: string }
  /** 风险 B：拟好回复但**必须人工确认**后才可发（历史上它与 A 同形，是个会漏钱的坑） */
  | { action: 'confirm'; script: ReplyScript; replyText: string; reason: string }
  /** 风险 C：不自动发，只能转人工 */
  | { action: 'handoff'; script: ReplyScript; replyText: string; reason: string }
  | { action: 'llm'; reason: string }

const SKIP_TEXT: Record<SkipReason, string> = {
  'from-team': '我方/团队已在群里发言，数字员工不插话',
  'non-text': '非文本消息（图片/语音/文件），当前无法理解内容，需人工看一眼',
  'ack-only': '纯应答（收到/好的/谢谢），无需回复',
  notice: '事务性通知（发货明细/对账单等），无需回复',
  'too-short': '内容过短，不足以判断诉求',
  empty: '空消息'
}

/** 渲染话术模板：支持 {{变量}}；未提供的变量原样保留（影子复盘时能看出模板缺变量） */
export function renderTemplate(tpl: string, vars: Record<string, string> = {}): string {
  return tpl.replace(/\{\{\s*([\w\u4e00-\u9fa5]+)\s*\}\}/g, (m, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] ?? '') : m
  )
}

/** 单条模式是否命中：关键词用包含（忽略大小写），正则容错（写错的正则跳过而不是崩掉整轮） */
function patternHit(text: string, type: 'kw' | 're', value: string): boolean {
  const v = value.trim()
  if (!v) return false
  if (type === 'kw') return text.toLowerCase().includes(v.toLowerCase())
  try {
    return new RegExp(v, 'i').test(text)
  } catch {
    return false
  }
}

/** 命中的模式描述（写进 reason，便于回放时核对是哪条规则触发的） */
function hitLabel(script: ReplyScript, text: string): string {
  for (const p of script.patterns) {
    if (patternHit(text, p.type, p.value)) {
      return `${p.type === 're' ? '正则' : '关键词'}「${p.value}」`
    }
  }
  return '（模式已变更）'
}

export function matchReply(input: MatchInput, scripts: ReplyScript[]): MatchResult {
  const text = (input.text || '').replace(/\s+/g, ' ').trim()
  if (input.fromTeam)
    return { action: 'skip', skipReason: 'from-team', reason: SKIP_TEXT['from-team'] }
  if (!text) return { action: 'skip', skipReason: 'empty', reason: SKIP_TEXT.empty }
  if (input.nonText)
    return { action: 'skip', skipReason: 'non-text', reason: SKIP_TEXT['non-text'] }
  if (text.length < 2)
    return { action: 'skip', skipReason: 'too-short', reason: SKIP_TEXT['too-short'] }
  if (isTransactionalNotice(text))
    return { action: 'skip', skipReason: 'notice', reason: SKIP_TEXT.notice }
  if (isAckOnly(text))
    return { action: 'skip', skipReason: 'ack-only', reason: SKIP_TEXT['ack-only'] }

  const sorted = [...scripts]
    .filter((s) => s.enabled && s.patterns.length > 0)
    .sort((a, b) => a.priority - b.priority || a.id - b.id)
  for (const s of sorted) {
    const hit = s.patterns.some((p) => patternHit(text, p.type, p.value))
    if (!hit) continue
    const replyText = renderTemplate(s.replyText, input.vars)
    const by = hitLabel(s, text)
    if (s.riskLevel === 'C') {
      return {
        action: 'handoff',
        script: s,
        replyText,
        reason: `命中高风险话术「${s.title || s.intent}」(${by})：不自动发送，转人工处理`
      }
    }
    if (s.riskLevel === 'B') {
      return {
        action: 'confirm',
        script: s,
        replyText,
        reason: `命中话术「${s.title || s.intent}」(${by})：需人工确认后发送`
      }
    }
    return {
      action: 'reply',
      script: s,
      replyText,
      reason: `命中话术「${s.title || s.intent}」(${by})`
    }
  }

  return { action: 'llm', reason: '未命中任何话术，需 LLM 兜底生成（仍过风险闸门）' }
}
