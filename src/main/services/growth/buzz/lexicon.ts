/**
 * 舆情词库与本地规则评分(餐饮行业)。
 * 目标: 不依赖模型即可给出可解释的倾向分; 模型只做补充与归因。
 * 口径: 每组命中一次计权, 汇总后压到 -100..100。
 */

export interface LexiconHit {
  tag: string
  weight: number
  evidence: string
}

export interface LexiconGroup {
  tag: string
  weight: number
  words: string[]
  /** 命中即判定食品安全红线 */
  redline?: boolean
}

/** 食品安全 / 卫生红线: 命中强制负面 + 高风险, 且不做正向抵扣 */
export const REDLINE_GROUPS: LexiconGroup[] = [
  {
    tag: '食品安全-异物',
    weight: -45,
    redline: true,
    words: [
      '异物',
      '头发',
      '苍蝇',
      '蟑螂',
      '老鼠',
      '虫子',
      '钢丝球',
      '塑料片',
      '玻璃渣',
      '指甲',
      '蟑螂爬',
      '苍蝇乱飞'
    ]
  },
  {
    tag: '食品安全-变质',
    weight: -40,
    redline: true,
    words: ['变质', '发霉', '馊了', '酸了', '臭了', '过期', '坏了', '不新鲜', '有异味', '哈喇味']
  },
  {
    tag: '食品安全-身体不适',
    weight: -50,
    redline: true,
    words: ['拉肚子', '腹泻', '食物中毒', '呕吐', '中毒', '肠胃炎', '进医院', '挂水', '急性肠胃']
  },
  {
    tag: '卫生环境',
    weight: -30,
    redline: true,
    words: ['卫生差', '不干净', '洗不干净', '很脏', '太脏', '脏乱', '油污', '餐具脏', '厕所味']
  }
]

/** 一般负面(口味/服务/价格/体验) */
export const NEGATIVE_GROUPS: LexiconGroup[] = [
  {
    tag: '口味差评',
    weight: -12,
    words: [
      '难吃',
      '不好吃',
      '太咸',
      '太油',
      '太甜',
      '齁',
      '腥',
      '凉了',
      '冷掉',
      '没味',
      '难以下咽',
      '齁咸',
      '油腻'
    ]
  },
  {
    tag: '服务差评',
    weight: -14,
    words: [
      '态度差',
      '不理人',
      '没人管',
      '等太久',
      '排队太久',
      '上错菜',
      '漏单',
      '推诿',
      '甩脸',
      '区别对待',
      '不耐烦',
      '催了',
      '敷衍',
      '凶'
    ]
  },
  {
    tag: '价格争议',
    weight: -13,
    words: [
      '太贵',
      '贵了',
      '坑',
      '刺客',
      '加价',
      '隐形消费',
      '乱收费',
      '不开发票',
      '霸王条款',
      '强制消费',
      '缺斤少两'
    ]
  },
  {
    tag: '体验负面',
    weight: -16,
    words: [
      '失望',
      '再也不来',
      '避雷',
      '差评',
      '踩雷',
      '后悔',
      '拉黑',
      '恶心',
      '劝退',
      '不值',
      '投诉',
      '曝光',
      '维权',
      '退款'
    ]
  },
  {
    tag: '环境负面',
    weight: -9,
    words: ['环境差', '太吵', '拥挤', '有味儿', '味道大', '闷']
  }
]

/** 正向(口味/服务/价格/环境/复购) */
export const POSITIVE_GROUPS: LexiconGroup[] = [
  {
    tag: '口味好评',
    weight: 12,
    words: [
      '好吃',
      '美味',
      '香',
      '入味',
      '新鲜',
      '绝了',
      '惊艳',
      '必点',
      '爆赞',
      'yyds',
      '爱了',
      '正宗'
    ]
  },
  {
    tag: '服务好评',
    weight: 11,
    words: ['热情', '贴心', '服务好', '耐心', '周到', '暖心', '点赞', '细致', '有温度', '主动']
  },
  {
    tag: '价格好评',
    weight: 10,
    words: ['实惠', '划算', '性价比', '便宜', '量大', '份量足', '良心', '物超所值']
  },
  {
    tag: '环境好评',
    weight: 9,
    words: ['干净', '卫生好', '环境好', '敞亮', '舒服', '氛围好', '打卡', '出片']
  },
  {
    tag: '复购推荐',
    weight: 14,
    words: ['回头客', '常来', '老顾客', '还会再来', '回购', '带朋友', '推荐给', '安利']
  }
]

const ALL_GROUPS: LexiconGroup[] = [...REDLINE_GROUPS, ...NEGATIVE_GROUPS, ...POSITIVE_GROUPS]

/** 单条文本扫描: 每组最多计一次, 取命中的第一个词作为证据 */
export function scanText(text: string): { hits: LexiconHit[]; redline: boolean } {
  const src = (text || '').toLowerCase()
  const hits: LexiconHit[] = []
  let redline = false
  if (!src) return { hits, redline }
  for (const g of ALL_GROUPS) {
    const word = g.words.find((w) => src.includes(w.toLowerCase()))
    if (!word) continue
    hits.push({ tag: g.tag, weight: g.weight, evidence: word })
    if (g.redline) redline = true
  }
  return { hits, redline }
}

/** 原始分 → 平滑到 -100..100(负向更敏感) */
export function smooth(raw: number): number {
  if (raw === 0) return 0
  const span = raw > 0 ? 55 : 42
  const v = 100 * (1 - Math.exp(-Math.abs(raw) / span))
  return Math.round(raw > 0 ? v : -v)
}

export interface RuleScoreInput {
  text: string
  comments: Array<{ content: string; likes: number; isHigh: boolean }>
  interactions: { likes: number; collects: number; comments: number; shares: number }
}

export interface RuleScoreResult {
  score: number
  hits: LexiconHit[]
  commentHits: LexiconHit[]
  redline: boolean
  redlineTags: string[]
  /** 评论区负面占比 0..1(按权重) */
  negativeRatio: number
  /** 传播量级(互动总量, 用于风险放大) */
  volume: number
}

/**
 * 规则分: 正文 + 评论加权。
 * - 评论权重 = 1 + log10(1 + 赞数), 高赞评论再 x1.5;
 * - 负面命中随互动量放大(传播风险), 正向不放大;
 * - 红线命中直接压到 -62 以下。
 */
export function ruleScore(input: RuleScoreInput): RuleScoreResult {
  const main = scanText(input.text)
  let raw = main.hits.reduce((s, h) => s + h.weight, 0)
  const hits = [...main.hits]
  let redline = main.redline

  let negWeight = 0
  let posWeight = 0
  const commentHits: LexiconHit[] = []
  for (const c of input.comments) {
    const r = scanText(c.content)
    if (r.hits.length === 0) continue
    const w = (1 + Math.log10(1 + Math.max(0, c.likes))) * (c.isHigh ? 1.5 : 1)
    const sum = r.hits.reduce((s, h) => s + h.weight, 0)
    raw += sum * w
    if (sum < 0) negWeight += w
    else posWeight += w
    if (r.redline) {
      redline = true
      commentHits.push(...r.hits)
    }
  }

  const volume =
    input.interactions.likes +
    input.interactions.comments * 2 +
    input.interactions.collects +
    input.interactions.shares * 2
  if (raw < 0 && volume > 0) {
    raw *= 1 + Math.min(0.6, Math.log10(1 + volume) / 12)
  }

  let score = smooth(raw)
  if (redline) score = Math.min(score, -62)
  const total = negWeight + posWeight
  const allHits = [...hits, ...commentHits]
  return {
    score,
    hits,
    commentHits,
    redline,
    redlineTags: Array.from(
      new Set(allHits.filter((h) => REDLINE_GROUPS.some((g) => g.tag === h.tag)).map((h) => h.tag))
    ),
    negativeRatio: total > 0 ? negWeight / total : 0,
    volume
  }
}

export function sentimentOf(score: number): 'positive' | 'neutral' | 'negative' {
  if (score <= -20) return 'negative'
  if (score >= 20) return 'positive'
  return 'neutral'
}

export function riskOf(score: number, redline: boolean): 'high' | 'medium' | 'low' {
  if (redline || score <= -60) return 'high'
  if (score <= -20) return 'medium'
  return 'low'
}

export const SENTIMENT_LABEL: Record<string, string> = {
  positive: '积极',
  neutral: '中性',
  negative: '消极',
  '': '待诊断'
}

export const RISK_LABEL: Record<string, string> = {
  high: '高风险',
  medium: '需关注',
  low: '低风险',
  '': '未评级'
}
