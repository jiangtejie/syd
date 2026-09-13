import { createHash } from 'node:crypto'
import { getConfig, setConfig } from '../../db/repos/config'
import {
  countRepliesMissingIntent,
  listRepliesMissingIntent,
  setReplyIntent,
  type AgentReply
} from '../../db/repos/agentReplyRepo'
import { listScripts } from '../../db/repos/replyScriptRepo'
import { createAiProvider } from '../ai/provider'
import { createLogger } from '../logging'
import {
  INTENT_FALLBACK,
  builtinIntentLabels,
  classifyByRules,
  normalizeIntentText
} from './intentLexicon'

const intentLog = createLogger('agent')

/**
 * 数字员工的**意图识别**(规则优先 + 模型复核)。
 *
 * 为什么需要它:此前只有「命中话术」才有 intent,走 LLM 兜底那条路径 intent 恒为空,
 * 于是 Base 的「意图」列大量空白 —— 复盘时说不清客户到底在问什么,也没法按意图补话术。
 *
 * 三层策略(成本从低到高,能停就停):
 *   L1 命中话术     → 直接用话术的 intent(权威,同事自己维护的)
 *   L2 规则层       → 内置词典打分,置信度 ≥ 0.7 直接采纳(零成本、可解释、离线可测)
 *   L3 模型复核     → 只在规则拿不准时问一次模型,**限定只能从标签表里选**(不许自创标签),结果按文本缓存
 * 三层都没结论 → 「其他」+ 来源 none,界面据此提示「待补话术」,而不是留空。
 */

/** 意图来源(写进 DB 与 Base,便于统计识别质量) */
export type IntentSource = 'script' | 'rule' | 'llm' | 'none'

export interface IntentResult {
  intent: string
  source: IntentSource
  confidence: number
  evidence: string[]
}

/** 来源 → 人话(Base 的单选列 & 界面徽标共用) */
export const INTENT_SOURCE_TEXT: Record<IntentSource, string> = {
  script: '话术',
  rule: '规则',
  llm: '模型',
  none: '未归类'
}

export function intentSourceText(source: string): string {
  return INTENT_SOURCE_TEXT[(source || 'none') as IntentSource] ?? '未归类'
}

/** 规则层置信度低于它 → 值得请模型复核 */
const REVIEW_BELOW = 0.7
/** 模型复核结果的缓存(文本 hash → 结论),避免同一句话反复问模型 */
const CFG_CACHE = 'agent.intentCache'
const CACHE_MAX = 400

function textKey(text: string): string {
  return createHash('sha1').update(normalizeIntentText(text)).digest('hex').slice(0, 16)
}

function readCache(): Record<string, { intent: string; confidence: number }> {
  const raw = (getConfig(CFG_CACHE) ?? '').trim()
  if (!raw) return {}
  try {
    const v = JSON.parse(raw) as unknown
    if (!v || typeof v !== 'object') return {}
    return v as Record<string, { intent: string; confidence: number }>
  } catch {
    return {}
  }
}

function writeCache(key: string, value: { intent: string; confidence: number }): void {
  const cache = readCache()
  cache[key] = value
  const keys = Object.keys(cache)
  if (keys.length > CACHE_MAX) {
    // 超限就丢最早写入的一批(对象键序即插入序)
    for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete cache[k]
  }
  setConfig(CFG_CACHE, JSON.stringify(cache))
}

/** 标签表 = 内置标签 + 该账号话术库里同事自己起的意图(去重,顺序稳定) */
export function intentLabelSet(wxid?: string): string[] {
  const out = [...builtinIntentLabels()]
  if (wxid) {
    try {
      for (const s of listScripts(wxid, { enabledOnly: true })) {
        const label = (s.intent || '').trim()
        if (label && !out.includes(label)) out.push(label)
      }
    } catch {
      // 话术表读不到就用内置标签,不影响识别
    }
  }
  return out
}

/** 话术自带的意图:命中话术时直接采纳,不再跑规则 */
export function intentFromScript(intent: string): IntentResult {
  return { intent: intent.trim(), source: 'script', confidence: 1, evidence: ['命中话术'] }
}

/** 只跑规则层(同步、零成本):预览/回填默认走它 */
export function classifyIntentByRules(text: string): IntentResult {
  const hit = classifyByRules(text)
  if (!hit) return { intent: INTENT_FALLBACK, source: 'none', confidence: 0, evidence: [] }
  return {
    intent: hit.intent,
    source: 'rule',
    confidence: hit.confidence,
    evidence: hit.evidence
  }
}

function parseLlmJson(raw: string): { intent?: string; confidence?: number } | null {
  const text = (raw ?? '').trim()
  if (!text) return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const v = JSON.parse(text.slice(start, end + 1)) as { intent?: unknown; confidence?: unknown }
    return {
      intent: typeof v.intent === 'string' ? v.intent.trim() : undefined,
      confidence: Number.isFinite(Number(v.confidence)) ? Number(v.confidence) : undefined
    }
  } catch {
    return null
  }
}

/**
 * 让模型在**闭集标签**里选一个。约束有三条,都是为了「不胡说」:
 * 1. 只能输出标签表里的词,不在表里一律按「其他」处理;
 * 2. 要求给出 confidence,低于 0.6 视为没把握 → 保持规则层结论;
 * 3. 失败/超时/返回不合法 → 静默回退,绝不让识别流程报错。
 */
async function reviewWithLlm(
  text: string,
  labels: string[]
): Promise<{ intent: string; confidence: number } | null> {
  const provider = createAiProvider()
  if (!provider) return null
  const system = [
    '你是客服群的意图分类器。只做分类,不回答客户。',
    '从下面的标签里选出最贴切的一个,只能选一个:',
    labels.join('、'),
    '拿不准就输出 其他,不要编造标签表以外的词。',
    '只输出 JSON:{"intent":"标签","confidence":0~1}'
  ].join('\n')
  try {
    const raw = await provider.complete(system, `客户消息：${text.slice(0, 300)}`, {
      maxTokens: 120
    })
    const parsed = parseLlmJson(raw)
    if (!parsed?.intent) return null
    const intent = labels.includes(parsed.intent) ? parsed.intent : INTENT_FALLBACK
    const confidence = Math.max(0, Math.min(1, parsed.confidence ?? 0.6))
    if (confidence < 0.6) return null
    return { intent, confidence }
  } catch (e) {
    intentLog.warn(
      `意图模型复核失败(已回退规则结论): ${e instanceof Error ? e.message : String(e)}`
    )
    return null
  }
}

/**
 * 识别一条消息的意图。
 * allowLlm=false 时**绝不联网**(回填历史、预演走这条路);true 时才在规则拿不准时请模型复核一次。
 */
export async function classifyIntent(
  text: string,
  opts: { wxid?: string; allowLlm?: boolean } = {}
): Promise<IntentResult> {
  const rule = classifyIntentByRules(text)
  if (!opts.allowLlm) return rule
  if (rule.source === 'rule' && rule.confidence >= REVIEW_BELOW) return rule
  const key = textKey(text)
  const cached = readCache()[key]
  if (cached) {
    return {
      intent: cached.intent,
      source: 'llm',
      confidence: cached.confidence,
      evidence: ['模型复核']
    }
  }
  const reviewed = await reviewWithLlm(text, intentLabelSet(opts.wxid))
  if (!reviewed) return rule
  writeCache(key, reviewed)
  return {
    intent: reviewed.intent,
    source: 'llm',
    confidence: reviewed.confidence,
    evidence: ['模型复核']
  }
}

export interface BackfillResult {
  ok: boolean
  scanned: number
  filled: number
  /** 各意图各补了多少条(none = 仍然未归类) */
  byIntent: Array<{ intent: string; n: number }>
  remaining: number
}

/**
 * 补全历史记录的意图(只跑规则层,零成本;不动决策与发送状态)。
 * 之前 intent 为空的记录大多是 LLM 兜底那条路径写下的,正是它们让 Base 的意图列一片空白。
 */
export function backfillReplyIntents(limit = 500): BackfillResult {
  const rows: AgentReply[] = listRepliesMissingIntent(limit)
  const by = new Map<string, number>()
  let filled = 0
  for (const r of rows) {
    const res = classifyIntentByRules(r.triggerText)
    // 重跑「未归类」时:新结论仍是兜底就不写(不让记录在 其他↔其他 之间来回刷)
    if (res.source === 'none' && (r.intent ?? '') !== '') continue
    setReplyIntent(r.id, {
      intent: res.intent,
      source: res.source,
      confidence: res.confidence,
      evidence: res.evidence.join('、')
    })
    by.set(res.intent, (by.get(res.intent) ?? 0) + 1)
    filled++
  }
  return {
    ok: true,
    scanned: rows.length,
    filled,
    byIntent: [...by.entries()].map(([intent, n]) => ({ intent, n })).sort((a, b) => b.n - a.n),
    remaining: countRepliesMissingIntent()
  }
}
