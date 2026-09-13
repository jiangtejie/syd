/**
 * 意图识别的**规则层**(纯函数,零依赖、可离线自检)。
 *
 * 为什么要有它:数字员工此前只有「命中话术」才有意图,走 LLM 兜底的那条路径 intent 是空字符串 ——
 * 于是 Base 里的「意图」列大量为空,复盘时说不清客户到底在问什么。
 *
 * 设计取舍:
 * 1. **先规则后模型**:规则层确定、可解释、零成本、离线可测;只有规则拿不准时才请模型补一刀;
 * 2. **必须有证据**:每条判定都带上命中的词(evidence),同事质疑时能当场复现,而不是「模型说的」;
 * 3. **永不返回空**:拿不准就给「其他」并标低置信,让界面能筛出来补话术,而不是留一个空列;
 * 4. **否定词参与打分**:「发票到了吗」不能被「到了吗」判成到货时间 —— 否定/竞争标签要能把分拉回来。
 */

/** 兜底标签:规则与模型都不确定时用它,绝不留空 */
export const INTENT_FALLBACK = '其他'

/** 权重:强特征 3 / 弱特征 1 / 否定 -4(足以把一次强命中抵消掉) */
const W_STRONG = 3
const W_WEAK = 1
const W_NEG = -4

export interface IntentRule {
  intent: string
  /** 强特征:命中基本就是它(命中一个就够下判断) */
  strong: string[]
  /** 弱特征:辅助信号,单独出现不足以定案(如「到了吗」) */
  weak: string[]
  /** 正则强特征(比对关键词更精确的组合,如「几天.到」) */
  re?: string[]
  /** 否定特征:出现就说明不是这个意图(如「退」对「到货时间」) */
  negative?: string[]
}

export interface IntentHit {
  intent: string
  /** 0~0.95,越高越稳;规则层的分数不是概率,只用于排序与「要不要请模型复核」 */
  confidence: number
  score: number
  /** 与第二名的分差(越大越不容易是两个意图在打架) */
  margin: number
  /** 命中的词(最多 3 个),给人看 */
  evidence: string[]
}

/**
 * 内置意图表(覆盖食材供应链群里最高频的问法)。
 * 标签命名与「推荐话术模板」保持一致,这样话术库、Base 的意图列、复盘统计是同一套词。
 */
export const INTENT_RULES: IntentRule[] = [
  {
    intent: '到货时间',
    strong: [
      '到货了没',
      '到货了吗',
      '到仓了没',
      '到仓了吗',
      '什么时候到',
      '啥时候到',
      '多久能到',
      '几天能到',
      '什么时候能到',
      '到不了'
    ],
    weak: ['到了吗', '能到吗', '到货', '到仓', '几号到', '催货'],
    re: ['(多久|几天|啥时候|什么时候).{0,4}(到|发)'],
    negative: ['退款', '退货', '发票', '对账']
  },
  {
    intent: '缺货先发',
    strong: ['有货先发', '缺货', '压单', '先发一部分', '先发一部分货'],
    weak: ['先发', '没货', '缺了', '断货', '库存'],
    negative: ['退款', '投诉']
  },
  {
    intent: '发票进度',
    strong: ['发票', '开票', '专票', '普票', '税号'],
    weak: ['开一下', '开具', '票'],
    negative: ['退货']
  },
  {
    intent: '对账单/单据',
    strong: ['对账单', '对账', '送货单', '结算单', '单据', '电子单', '账单'],
    weak: ['单子', '对一下', '核一下', '盖章', '开给我', '发我一下'],
    negative: ['发票']
  },
  {
    intent: '物流查询',
    strong: ['物流', '快递', '单号', '运单', '到哪了', '发车', '司机', '运输'],
    weak: ['路上', '在途', '车到哪', '多久送到'],
    negative: ['排车']
  },
  {
    intent: '排车安排',
    strong: ['排车', '派车', '装车', '送货安排'],
    weak: ['车安排', '明天送', '几点送', '安排车'],
    negative: ['物流']
  },
  {
    intent: '催单',
    strong: ['催一下', '催一催', '催催', '帮我催'],
    weak: ['尽快', '赶紧', '着急', '急', '什么时候能', '还没好'],
    negative: []
  },
  {
    intent: '营业时间',
    strong: ['营业时间', '几点开门', '几点关门', '几点下班', '上班时间'],
    weak: ['开门', '下班', '休息', '放假'],
    negative: []
  },
  {
    intent: '价格优惠',
    strong: ['价格', '报价', '多少钱', '优惠', '折扣', '便宜点', '降价', '单价', '总价'],
    weak: ['便宜', '贵', '涨价', '活动价', '金额', '结算金额', '没显示'],
    negative: ['退款']
  },
  {
    intent: '系统下单问题',
    strong: ['系统', '小程序', '登录不了', '上不去', '下单不了', '报错', '后台'],
    weak: ['账号', '密码', '打不开', '刷不出', '崩了'],
    negative: []
  },
  {
    intent: '配件补发',
    strong: ['配件', '补发', '漏发', '少了', '缺件'],
    weak: ['少一件', '没给', '漏了', '包装'],
    negative: ['退款', '退货']
  },
  {
    intent: '退款退货',
    strong: ['退款', '退货', '退钱', '理赔', '赔偿'],
    weak: ['退一下', '不要了', '售后'],
    negative: []
  },
  {
    intent: '质量投诉',
    strong: [
      '投诉',
      '变质',
      '发霉',
      '有异味',
      '不新鲜',
      '坏了',
      '烂了',
      '有虫',
      '胀气',
      '鼓包',
      '漏气',
      '发酸',
      '发臭',
      '长毛',
      '有异物',
      '过期',
      '压烂'
    ],
    weak: ['质量', '臭了', '压坏了', '压坏了', '化冻', '口感', '变味', '颜色不对', '不对头'],
    negative: []
  },
  {
    // 真实库里最高频的一类:「门店订货啦」「央厨下单 麻烦安排一下」「加个单」
    intent: '下单订货',
    strong: [
      '下单',
      '订货',
      '加个单',
      '加单',
      '再订',
      '订一批',
      '订一箱',
      '订一锅',
      '备货',
      '备一锅',
      '要货',
      '报单'
    ],
    weak: ['安排一下', '麻烦安排', '送过来', '加个', '加点'],
    negative: ['退款', '退货', '投诉']
  },
  {
    // 「需要配送货物」「要下午装货了」「喀什不忙发货」——与「物流查询（货在哪）」区分开
    intent: '发货配送',
    strong: ['配送', '发货', '送货', '装货', '安排送', '送到店', '发过来'],
    weak: ['送过来', '送一车', '下午装', '不忙发'],
    negative: ['退款', '退货', '物流', '单号', '到哪了']
  },
  {
    intent: '合同资质',
    strong: ['合同', '资质', '营业执照', '检疫', '检测报告', '食品经营许可'],
    weak: ['证件', '备案', '证照', '盖章件'],
    negative: []
  }
]

/**
 * 文本归一化:先把**真实群聊的噪声**剔掉,再归一化。
 *
 * 为什么要这么多步:群里「一条消息」常常是若干条拼起来的 ——
 * `[图片]\n@萍姐物配客服-黄巧-17723603132 老师这个鸡爪胀气了\n收到\n"亦春" 撤回了一条消息`。
 * 不清理的话,「胀气了」这种真信号会被 @提及、占位符、撤回提示淹没,识别只好全判「其他」。
 * 清理规则刻意保守:只去**结构性噪声**(系统行/会话id/@提及/占位标记/手机号),正文一个字不动。
 */
export function normalizeIntentText(raw: string): string {
  let s = String(raw ?? '')
  // 全角 ASCII → 半角(含全角空格)
  s = s.replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  s = s.replace(/[\u3000\u200b-\u200f\ufeff]/g, ' ')
  s = s.toLowerCase()
  // 逐行剔掉与业务无关的系统消息行
  const kept: string[] = []
  for (const line of s.split(/\n+/)) {
    const t = line.trim()
    if (!t) continue
    if (/撤回了一条消息|加入了群聊|退出了群聊|群公告|拍了拍|的聊天记录/.test(t)) continue
    kept.push(t)
  }
  s = kept.join(' ')
  // 会话 id 前缀:123456@chatroom: / 25984982726342452@openim:
  s = s.replace(/\d+@(chatroom|openim)\s*[:：]?/g, ' ')
  // @提及(形如 @萍姐物配客服-黄巧-17723603132):只去提及本身,后面正文要留下
  s = s.replace(/@[^\s@，。,;；]{1,30}/g, ' ')
  // 占位标记 [图片]/[语音]/[文件]/[消息]/[抱拳];文件名等正文保留
  s = s.replace(/\[[^\]]{1,12}\]/g, ' ')
  // 手机号
  s = s.replace(/\b1[3-9]\d{9}\b/g, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  return s
}

interface PatternHit {
  intent: string
  value: string
  weight: number
}

function collectHits(text: string, rules: IntentRule[]): Map<string, PatternHit[]> {
  const out = new Map<string, PatternHit[]>()
  for (const rule of rules) {
    const hits: PatternHit[] = []
    const push = (value: string, weight: number): void => {
      hits.push({ intent: rule.intent, value, weight })
    }
    for (const v of rule.strong) if (v && text.includes(v.toLowerCase())) push(v, W_STRONG)
    for (const v of rule.weak) if (v && text.includes(v.toLowerCase())) push(v, W_WEAK)
    for (const v of rule.re ?? []) {
      try {
        if (new RegExp(v, 'i').test(text)) push('/' + v + '/', W_STRONG)
      } catch {
        // 写错的正则跳过:一条坏规则不该拖垮整轮识别
      }
    }
    for (const v of rule.negative ?? [])
      if (v && text.includes(v.toLowerCase())) push('非:' + v, W_NEG)
    if (hits.length > 0) out.set(rule.intent, hits)
  }
  return out
}

function scoreOf(hits: PatternHit[]): number {
  return hits.reduce((sum, h) => sum + h.weight, 0)
}

/**
 * 规则层识别:命中打分 → 取第一名 → 按「分数 + 与第二名的分差」折算置信度。
 * 没有任何命中(或最高分为负)时返回 null —— 由上层决定用「其他」兜底还是请模型复核。
 */
export function classifyByRules(text: string, extraRules: IntentRule[] = []): IntentHit | null {
  const t = normalizeIntentText(text)
  if (t.length < 2) return null
  const hits = collectHits(t, [...INTENT_RULES, ...extraRules])
  if (hits.size === 0) return null
  const scored = [...hits.entries()]
    .map(([intent, list]) => ({ intent, list, score: scoreOf(list) }))
    .sort((a, b) => b.score - a.score || a.intent.localeCompare(b.intent))
  const win = scored[0]
  if (!win || win.score <= 0) return null
  const second = scored[1]?.score ?? 0
  const margin = win.score - Math.max(0, second)
  const confidence = Math.max(0.3, Math.min(0.95, 0.3 + 0.12 * win.score + 0.08 * margin))
  const evidence = win.list
    .filter((h) => h.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
    .map((h) => h.value)
  return {
    intent: win.intent,
    confidence: Math.round(confidence * 100) / 100,
    score: win.score,
    margin,
    evidence
  }
}

/** 规则层的全部标签(给模型做「只能从这些里选」的白名单) */
export function builtinIntentLabels(): string[] {
  return INTENT_RULES.map((r) => r.intent)
}
