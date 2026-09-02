import type { ReplyCandidate } from '../../../shared/types'

/**
 * 内置模板话术（T7 降级用，对应方案 §4.7 兜底话术）。
 * 关键词命中 → 固定底稿（kb_direct），无 AI 依赖、可审计；
 * AI 不可用或未配置时保证工作台仍能给出安全建议。
 */

interface TemplateRule {
  /** 命中关键词（任一命中即用该话术） */
  keywords: string[]
  /** 优先度：命中多条时取 priority 最大者 */
  priority: number
  texts: string[]
  reason: string
}

const TEMPLATES: TemplateRule[] = [
  {
    keywords: ['退款', '换货', '退货', '投诉', '赔偿', '仲裁', '律师', '起诉'],
    priority: 90,
    reason: '敏感词命中，转人工',
    texts: [
      '非常理解您的心情，这个问题涉及售后处理，我需要为您转接专属客服进一步核实，请您稍等。',
      '您反馈的问题我已经记录，会尽快协调专人跟进，请您保持关注，感谢您的耐心。'
    ]
  },
  {
    keywords: ['价格', '多少钱', '费用', '收费', '套餐', '年费'],
    priority: 70,
    reason: '价格咨询模板',
    texts: [
      '您好，我们目前提供标准版（¥299/年）和企业版（¥499/年）两档套餐，具体权益我可以发给您一份对比表。',
      '关于价格，方便的话您先告诉我想了解哪个版本，我给您详细介绍对应权益和优惠。'
    ]
  },
  {
    keywords: ['试用', '体验', 'demo', '免费'],
    priority: 60,
    reason: '试用引导模板',
    texts: [
      '我们支持 14 天免费试用，您可以先体验完整功能，满意后再考虑付费。需要我帮您开通吗？',
      '可以的，我这边可以为您开通试用账号，注册后即可使用全部功能。'
    ]
  },
  {
    keywords: ['发货', '物流', '快递', '订单号', '什么时候到', '没收到'],
    priority: 55,
    reason: '订单/物流话术引导',
    texts: [
      '好的，为了帮您核实物流进度，麻烦您把订单号发我一下，我确认后第一时间回复您。',
      '收到，我先帮您查一下订单状态，还请您稍等片刻。'
    ]
  },
  {
    keywords: ['你好', '在吗', '在不在', '有人吗', 'hi', 'hello'],
    priority: 30,
    reason: '寒暄欢迎模板',
    texts: [
      '您好，很高兴为您服务，请问有什么可以帮您的？',
      '您好，在的，您请说，我随时为您解答。'
    ]
  }
]

/** 关键词命中：返回最高优先级的模板，未命中返回 null */
export function matchTemplate(text: string): TemplateRule | null {
  let best: TemplateRule | null = null
  const t = text.toLowerCase()
  for (const rule of TEMPLATES) {
    if (!rule.keywords.some((k) => t.includes(k.toLowerCase()))) continue
    if (!best || rule.priority > best.priority) best = rule
  }
  return best
}

/** 兜底话术（未命中任何模板时的安全回退，固定底稿） */
export const FALLBACK_TEXTS: string[] = [
  '您好，您的问题我已经收到了，正在为您核实，稍后给您准确答复，请稍等。',
  '收到，这边先帮您确认下细节，马上回复您。'
]

export function buildTemplateCandidates(text: string): ReplyCandidate[] {
  const hit = matchTemplate(text)
  if (hit) {
    return hit.texts.map((t) => ({ text: t, source: 'kb_direct' as const, reason: hit.reason }))
  }
  return FALLBACK_TEXTS.map((t) => ({
    text: t,
    source: 'kb_direct' as const,
    reason: '通用兜底话术'
  }))
}
