/**
 * 餐饮营销文案合规提示(轻量·提示级)。
 * 命中项随爆改产出展示给运营人工确认; 硬门禁与平台词库 Phase 1 质检流水线再做。
 */

const RULES: Array<{ re: RegExp; label: string }> = [
  {
    re: /最(好|大|快|新|低|高|正宗|便宜|受欢迎)|第一|顶级|国家级|唯一|首选|极致|王牌|销量.{0,6}(第一|冠军)|全网.{0,4}第一/i,
    label: '绝对化用语(广告法第九条风险)'
  },
  {
    re: /治病|疗效|减肥|瘦身|降脂|降糖|降压|养生|保健|抗癌|排毒|消炎|丰胸|壮阳|治疗|药效/i,
    label: '食品功效类宣称(普通食品禁止)'
  },
  {
    re: /纯天然|零添加|无添加|百分百|100%|绝对(不|无)|包好|永不|立竿见影|根治/i,
    label: '夸大或绝对化表述'
  },
  {
    re: /米其林|必比登|黑珍珠|获奖|央视|CCTV|老字号|非遗|排队.{0,6}(最长|第一|爆满)|大胃王/i,
    label: '背书性表述(需真实可证, 谨慎使用)'
  },
  {
    re: /吊打|秒杀|碾压|比.{0,8}家强|最便宜.{0,6}家|假一赔十/i,
    label: '贬低同行/对比广告风险'
  },
  {
    re: /免费吃|0元吃|白嫖|最后.{0,4}(1天|一天|小时)|仅限今日|再不.{0,4}就|错过.{0,4}等/i,
    label: '促销紧迫表述(需与活动规则一致)'
  }
]

/** 返回命中的合规提示(去重, 顺序稳定) */
export function checkCompliance(text: string): string[] {
  if (!text) return []
  const out: string[] = []
  for (const rule of RULES) {
    if (rule.re.test(text) && !out.includes(rule.label)) out.push(rule.label)
  }
  return out
}

export function checkComplianceBatch(texts: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of texts) {
    for (const hit of checkCompliance(t)) {
      if (!seen.has(hit)) {
        seen.add(hit)
        out.push(hit)
      }
    }
  }
  return out
}
