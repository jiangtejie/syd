/**
 * 舆情智能诊断: 规则分(词库) + 模型分(LLM 归因) → 融合评级。
 * - 规则分: 正文 + 高赞评论加权, 可解释、可离线;
 * - 模型分: 结合原创作者内容与评论区语义, 输出根因/建议;
 * - 融合: final = 0.4 x 规则 + 0.6 x 模型(无模型时退化为纯规则);
 * - 红线: 食品安全/卫生词命中 → 强制消极 + 高风险。
 */

import { createAiProvider } from '../../ai/provider'
import { describeModelError } from '../../ai/modelErrors'
import { createLogger } from '../../logging'
import {
  getMention,
  listComments,
  updateMention,
  type BuzzCommentView,
  type BuzzMentionView,
  type BuzzReasonView
} from '../../../db/repos/growthBuzzRepo'
import { parseModelJson } from '../remix/prompts'
import { riskOf, ruleScore, sentimentOf, type LexiconHit } from './lexicon'

const buzzLog = createLogger('growth-buzz')

/** 融合权重: 规则 0.4 / 模型 0.6 */
export const FUSION = { rule: 0.4, model: 0.6 }

export interface BuzzEvidence {
  author: string
  content: string
  likes: number
  isHigh: boolean
}

export interface BuzzDiagnosis {
  source: 'rule' | 'rule+model'
  ruleScore: number
  modelScore: number | null
  finalScore: number
  sentiment: string
  riskLevel: string
  severity: string
  summary: string
  rootCauses: string[]
  suggestions: string[]
  spreadRisk: string
  reasons: BuzzReasonView[]
  redlineTags: string[]
  commentCount: number
  highCommentCount: number
  evidence: BuzzEvidence[]
  diagnosedAt: number
}

function clampScore(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(v)) return 0
  return Math.max(-100, Math.min(100, Math.round(v)))
}

function strArr(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    .map((x) => x.trim())
    .slice(0, 8)
}

function hitsToReasons(hits: LexiconHit[]): BuzzReasonView[] {
  const seen = new Set<string>()
  const out: BuzzReasonView[] = []
  for (const h of hits) {
    const key = h.tag + '|' + h.evidence
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ tag: h.tag, weight: h.weight, evidence: h.evidence })
  }
  return out.slice(0, 12)
}

/** 证据: 高赞评论优先, 其次点赞靠前 */
function pickEvidence(comments: BuzzCommentView[]): BuzzEvidence[] {
  return comments
    .slice()
    .sort((a, b) => Number(b.isHigh) - Number(a.isHigh) || b.likes - a.likes)
    .slice(0, 8)
    .map((c) => ({
      author: c.authorName || '匿名',
      content: c.content,
      likes: c.likes,
      isHigh: c.isHigh
    }))
}

function buildSystem(): string {
  return [
    '你是连锁餐饮品牌的舆情分析师, 负责对抖音/小红书上的门店相关内容做舆情诊断。',
    '要求:',
    '1. 综合「原创作者内容」与「评论区高赞评论」判断整体情绪, 不能只看单条;',
    '2. 食品安全/卫生类问题(异物、变质、身体不适、卫生差)一律判为消极且 severity=high;',
    '3. 评分口径: -100 极端负面 .. 0 中性 .. +100 极度正面, 与情绪必须一致;',
    '4. rootCauses 要落到可执行的经营环节(出品、服务、等待、价格、卫生、沟通), 不要空话;',
    '5. suggestions 给 2-4 条可当天落地的动作(话术/流程/补偿/内容回应);',
    '6. 只输出 JSON, 不要解释、不要 markdown 代码块。',
    '',
    '输出 JSON 结构:',
    '{"sentiment":"positive|neutral|negative","score":0,"severity":"low|medium|high",',
    ' "summary":"一句话结论","rootCauses":["根因"],"spreadRisk":"传播风险评估",',
    ' "suggestions":["处置建议"],"reasons":[{"tag":"分类","weight":-10,"evidence":"依据"}]}'
  ].join('\n')
}

function buildUser(
  mention: BuzzMentionView,
  comments: BuzzCommentView[],
  rule: ReturnType<typeof ruleScore>
): string {
  const lines: string[] = []
  lines.push('【门店】' + (mention.storeName || '未关联门店'))
  lines.push(
    '【平台】' + (mention.platform || '-') + ' / ' + (mention.kind === 'video' ? '视频' : '图文')
  )
  lines.push('【链接】' + (mention.url || '-'))
  lines.push(
    '【作者】' +
      (mention.authorName || '未知') +
      (mention.authorId ? ' (' + mention.authorId + ')' : '')
  )
  lines.push('【标题】' + (mention.title || '-'))
  lines.push('【正文】' + (mention.contentText || '-').slice(0, 1200))
  const it = mention.interactions
  lines.push(
    '【互动】赞 ' +
      String(it.likes) +
      ' / 藏 ' +
      String(it.collects) +
      ' / 评 ' +
      String(it.comments) +
      ' / 转 ' +
      String(it.shares)
  )
  lines.push(
    '【本地规则分】' +
      String(rule.score) +
      ' 红线=' +
      (rule.redline ? '命中(' + rule.redlineTags.join('、') + ')' : '无')
  )
  if (rule.hits.length > 0) {
    lines.push('【正文命中】' + rule.hits.map((h) => h.tag + ':' + h.evidence).join(', '))
  }
  if (comments.length === 0) {
    lines.push('【评论】暂无采集到的评论(仅依据正文判断)')
  } else {
    lines.push(
      '【评论】共 ' +
        String(comments.length) +
        ' 条, 高赞 ' +
        String(comments.filter((c) => c.isHigh).length) +
        ' 条:'
    )
    for (const c of comments.slice(0, 30)) {
      lines.push(
        '- [' +
          String(c.likes) +
          '赞' +
          (c.isHigh ? '/高赞' : '') +
          '] ' +
          (c.authorName || '匿名') +
          ': ' +
          c.content.slice(0, 200)
      )
    }
  }
  lines.push('')
  lines.push('请按系统要求输出舆情诊断 JSON。')
  return lines.join('\n')
}

/** 调模型; 失败返回 null(降级为纯规则) */
async function modelDiagnose(
  mention: BuzzMentionView,
  comments: BuzzCommentView[],
  rule: ReturnType<typeof ruleScore>
): Promise<Record<string, unknown> | null> {
  const provider = createAiProvider('buzz')
  if (!provider) {
    buzzLog.info('ai provider not configured, rule-only diagnosis')
    return null
  }
  let raw = ''
  try {
    raw = await provider.complete(buildSystem(), buildUser(mention, comments, rule), {
      maxTokens: 1200
    })
  } catch (e) {
    buzzLog.warn(
      'model diagnose failed: ' +
        (describeModelError(e) || (e instanceof Error ? e.message : String(e)))
    )
    return null
  }
  const parsed = parseModelJson(raw)
  if (!parsed) {
    buzzLog.warn('model json unparsable, head: ' + raw.slice(0, 200))
    return null
  }
  return parsed
}

/** 纯规则兜底诊断 */
function ruleOnly(
  rule: ReturnType<typeof ruleScore>,
  comments: BuzzCommentView[]
): {
  summary: string
  rootCauses: string[]
  suggestions: string[]
  spreadRisk: string
  severity: string
} {
  const neg = rule.hits.filter((h) => h.weight < 0).map((h) => h.tag)
  const pos = rule.hits.filter((h) => h.weight > 0).map((h) => h.tag)
  const summary = rule.redline
    ? '命中食品安全/卫生红线(' + rule.redlineTags.join('、') + '), 需立即核实并处置'
    : rule.score <= -20
      ? '整体偏消极, 主要问题集中在' + (neg.slice(0, 3).join('、') || '内容表达')
      : rule.score >= 20
        ? '整体偏积极, 正向点集中在' + (pos.slice(0, 3).join('、') || '口味与服务')
        : '情绪中性, 暂无明确负面信号'
  const suggestions = rule.redline
    ? [
        '2 小时内联系当事顾客核实并留证(菜品/时间/座位)',
        '调取该时段出品与监控, 排查同批次',
        '评论区公开回应并给出补偿方案',
        '同步门店做卫生自查清单'
      ]
    : rule.score <= -20
      ? [
          '私信作者致歉并邀请复访, 避免评论继续发酵',
          '复盘当日班次与出品标准',
          '把高频差评点写入门店早会'
        ]
      : ['评论区及时回应并引导到店', '把正向评论沉淀为内容素材']
  return {
    summary,
    rootCauses: rule.hits
      .filter((h) => h.weight < 0)
      .map((h) => h.tag)
      .slice(0, 5),
    suggestions,
    spreadRisk:
      rule.volume > 2000
        ? '互动量较高(' + String(rule.volume) + '), 存在扩散风险'
        : comments.length > 0
          ? '互动量有限, 建议持续观察'
          : '暂无评论样本, 风险判断置信度较低',
    severity: rule.redline
      ? 'high'
      : rule.score <= -40
        ? 'high'
        : rule.score <= -20
          ? 'medium'
          : 'low'
  }
}

/**
 * 诊断一条舆情: 写回 sentiment/score/risk_level/reasons/diagnosis。
 * 失败会抛错(调用方决定是否提示), 模型不可用时自动降级为纯规则。
 */
export async function diagnoseMention(
  id: number,
  opts?: { useModel?: boolean }
): Promise<BuzzDiagnosis> {
  const mention = getMention(id)
  if (!mention) throw new Error('舆情记录不存在')
  const comments = listComments(id)
  const rule = ruleScore({
    text: [mention.title, mention.contentText].filter(Boolean).join('\n'),
    comments: comments.map((c) => ({ content: c.content, likes: c.likes, isHigh: c.isHigh })),
    interactions: mention.interactions
  })

  const model = opts?.useModel === false ? null : await modelDiagnose(mention, comments, rule)
  const fallback = ruleOnly(rule, comments)

  const modelScore = model ? clampScore(model['score']) : null
  let finalScore =
    modelScore === null
      ? rule.score
      : Math.round(FUSION.rule * rule.score + FUSION.model * modelScore)
  if (rule.redline) finalScore = Math.min(finalScore, -62)
  finalScore = clampScore(finalScore)

  const sentiment = rule.redline ? 'negative' : sentimentOf(finalScore)
  const severity =
    model && typeof model['severity'] === 'string' ? String(model['severity']) : fallback.severity
  const riskLevel = rule.redline || severity === 'high' ? 'high' : riskOf(finalScore, false)

  const reasons = hitsToReasons([...rule.hits, ...rule.commentHits])
  const modelReasons: BuzzReasonView[] = Array.isArray(model?.['reasons'])
    ? (model!['reasons'] as unknown[])
        .map((r) => {
          const o = (r ?? {}) as Record<string, unknown>
          return {
            tag: String(o['tag'] ?? '').trim() || '模型判断',
            weight: clampScore(o['weight']),
            evidence: String(o['evidence'] ?? '').slice(0, 200)
          }
        })
        .filter((r) => r.evidence !== '' || r.tag !== '模型判断')
        .slice(0, 6)
    : []

  const diagnosis: BuzzDiagnosis = {
    source: model ? 'rule+model' : 'rule',
    ruleScore: rule.score,
    modelScore,
    finalScore,
    sentiment,
    riskLevel,
    severity,
    summary:
      (model && typeof model['summary'] === 'string' && model['summary'].trim()) ||
      fallback.summary,
    rootCauses: model ? strArr(model['rootCauses']) : fallback.rootCauses,
    suggestions: model ? strArr(model['suggestions']) : fallback.suggestions,
    spreadRisk:
      (model && typeof model['spreadRisk'] === 'string' && model['spreadRisk'].trim()) ||
      fallback.spreadRisk,
    reasons: [...reasons, ...modelReasons].slice(0, 14),
    redlineTags: rule.redlineTags,
    commentCount: comments.length,
    highCommentCount: comments.filter((c) => c.isHigh).length,
    evidence: pickEvidence(comments),
    diagnosedAt: Date.now()
  }

  updateMention(id, {
    sentiment,
    score: finalScore,
    riskLevel,
    reasons: diagnosis.reasons,
    diagnosis: diagnosis as unknown as Record<string, unknown>
  })
  buzzLog.info(
    'diagnose id=' +
      String(id) +
      ' source=' +
      diagnosis.source +
      ' rule=' +
      String(rule.score) +
      ' model=' +
      String(modelScore) +
      ' final=' +
      String(finalScore) +
      ' sentiment=' +
      sentiment +
      ' risk=' +
      riskLevel +
      ' comments=' +
      String(comments.length)
  )
  return diagnosis
}
