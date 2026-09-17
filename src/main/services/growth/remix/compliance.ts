/**
 * 餐饮营销文案合规检查。
 *
 * **两档语义，别再退回「只有提示」**：
 * - `block`：法律风险（广告法绝对化用语、普通食品的功效宣称）—— 命中即**拒绝导出**；
 * - `warn`：平台规则 / 需人工判断（背书、贬低同行、促销紧迫、平台导流词）—— 展示提示，不阻断。
 *
 * 为什么导流词只 warn 不 block：本产品的核心闭环就是「公域内容导私域」，把「加微信」一刀切
 * 阻断等于把主用途堵死。平台确有导流限制，但那属于运营判断，产品给提示、不替用户做决定。
 * 反过来，功效宣称与极限词没有「用得对」的余地，所以是硬门禁。
 *
 * 纯函数、零依赖：scripts/growth-export-guard-selftest.mjs 直接跑。
 */

export type ComplianceLevel = 'block' | 'warn'

export interface ComplianceRule {
  level: ComplianceLevel
  code: string
  label: string
  re: RegExp
}

export interface ComplianceHit {
  level: ComplianceLevel
  code: string
  label: string
  /** 命中的原文片段（截断），给用户看「到底哪个词触发了」 */
  term: string
}

export const COMPLIANCE_RULES: ComplianceRule[] = [
  {
    level: 'block',
    code: 'absolute-wording',
    label: '绝对化用语(广告法第九条风险)',
    re: /最(好|大|快|新|低|高|正宗|便宜|受欢迎)|第一|顶级|国家级|唯一|首选|极致|王牌|销量.{0,6}(第一|冠军)|全网.{0,4}第一/i
  },
  {
    level: 'block',
    code: 'food-efficacy',
    label: '食品功效类宣称(普通食品禁止)',
    re: /治病|疗效|减肥|瘦身|降脂|降糖|降压|养生|保健|抗癌|排毒|消炎|丰胸|壮阳|治疗|药效/i
  },
  {
    level: 'warn',
    code: 'exaggeration',
    label: '夸大或绝对化表述',
    re: /纯天然|零添加|无添加|百分百|100%|绝对(不|无)|包好|永不|立竿见影|根治/i
  },
  {
    level: 'warn',
    code: 'endorsement',
    label: '背书性表述(需真实可证, 谨慎使用)',
    re: /米其林|必比登|黑珍珠|获奖|央视|CCTV|老字号|非遗|排队.{0,6}(最长|第一|爆满)|大胃王/i
  },
  {
    level: 'warn',
    code: 'disparage',
    label: '贬低同行/对比广告风险',
    re: /吊打|秒杀|碾压|比.{0,8}家强|最便宜.{0,6}家|假一赔十/i
  },
  {
    level: 'warn',
    code: 'urgency',
    label: '促销紧迫表述(需与活动规则一致)',
    re: /免费吃|0元吃|白嫖|最后.{0,4}(1天|一天|小时)|仅限今日|再不.{0,4}就|错过.{0,4}等/i
  },
  {
    level: 'warn',
    code: 'diversion',
    label: '平台导流词(各平台对站外引流有单独规则)',
    re: /微信|加微信|加我|私信我|主页联系|扣\s*1|[vV][xX]\s*[:：]\s*\S{3,}|[➕+]\s*[vV]\b/
  }
]

function termOf(text: string, re: RegExp): string {
  const m = re.exec(text)
  if (!m) return ''
  const at = Math.max(0, (m.index ?? 0) - 6)
  return (
    (at > 0 ? '…' : '') +
    text
      .slice(at, at + 28)
      .replace(/\s+/g, ' ')
      .trim()
  )
}

/** 单条文本的全部命中（去重按 code） */
export function checkComplianceHits(text: string): ComplianceHit[] {
  const t = (text ?? '').trim()
  if (!t) return []
  const out: ComplianceHit[] = []
  for (const rule of COMPLIANCE_RULES) {
    if (!rule.re.test(t)) continue
    out.push({ level: rule.level, code: rule.code, label: rule.label, term: termOf(t, rule.re) })
  }
  return out
}

/** 多段文本的命中（按 code 去重，保留第一条的命中片段） */
export function complianceHitsOf(texts: string[]): ComplianceHit[] {
  const seen = new Map<string, ComplianceHit>()
  for (const t of texts ?? []) {
    for (const h of checkComplianceHits(t)) {
      if (!seen.has(h.code)) seen.set(h.code, h)
      else if (!seen.get(h.code)!.term && h.term) seen.set(h.code, h)
    }
  }
  return [...seen.values()]
}

/** 只取阻断级命中（导出前用它做硬门禁） */
export function blockingHits(texts: string[]): ComplianceHit[] {
  return complianceHitsOf(texts).filter((h) => h.level === 'block')
}

/** 旧口径：只回标签（保留给既有调用方；新代码用上面的带 level 版本） */
export function checkCompliance(text: string): string[] {
  return checkComplianceHits(text).map((h) => h.label)
}

export function checkComplianceBatch(texts: string[]): string[] {
  return complianceHitsOf(texts).map((h) => h.label)
}
