import type { ReplyScriptInput } from '../../db/repos/replyScriptRepo'

/**
 * 推荐话术模板（一期：只做「接住话头 + 承诺动作」，不编造业务事实）。
 *
 * 为什么这样设计：真实群里的问法是「孜然粉到货了没」「鸡爪今天到不了吗」「发票开了吗」——
 * 答案依赖**当下的库存/物流/财务事实**，一期还没有这些查询工具（二期接），
 * 所以话术只能承诺**动作**（我查一下 / 我让物配确认 / 稍后答复），绝不承诺**结果与数字**。
 * 只有口径确定、与事实无关的场景（营业时间/开票资料/单据格式）才直接给结论。
 *
 * 风险分级按「答错代价」定：涉及钱、赔付、投诉、合同的一律 C（永不自动，转人工）。
 */
export const STARTER_SCRIPTS: ReplyScriptInput[] = [
  {
    intent: '到货时间',
    title: '问到货/到仓时间',
    patterns: [
      { type: 'kw', value: '到货了没' },
      { type: 'kw', value: '到仓了没' },
      { type: 'kw', value: '到了吗' },
      { type: 'kw', value: '到不了' },
      { type: 'kw', value: '什么时候到' },
      { type: 're', value: '(多久|几天|啥时候|什么时候).{0,4}(到|发)' }
    ],
    replyText: '{{客户名}}好，我这边先看一下这批货的到货进度，确认好马上回复您 🙏',
    riskLevel: 'A',
    priority: 10
  },
  {
    intent: '缺货先发',
    title: '缺货/有货先发确认',
    patterns: [
      { type: 'kw', value: '有货先发' },
      { type: 'kw', value: '先发' },
      { type: 'kw', value: '缺货' },
      { type: 'kw', value: '压单' }
    ],
    replyText: '收到，我先跟物配确认库存，有货的部分先安排发走，缺的到仓后补发，确认后回您。',
    riskLevel: 'A',
    priority: 20
  },
  {
    intent: '发票进度',
    title: '发票开具/进度',
    patterns: [
      { type: 'kw', value: '发票' },
      { type: 'kw', value: '开票' }
    ],
    replyText: '{{客户名}}好，发票的事我记下了，帮您跟财务确认一下进度，开好第一时间发您。',
    riskLevel: 'A',
    priority: 30
  },
  {
    intent: '对账单/单据',
    title: '对账单与单据',
    patterns: [
      { type: 'kw', value: '对账单' },
      { type: 'kw', value: '对账' },
      { type: 'kw', value: '单子' },
      { type: 'kw', value: '单据' }
    ],
    replyText: '好的，对账单/单据我整理一下发您，稍等。',
    riskLevel: 'A',
    priority: 40
  },
  {
    intent: '物流查询',
    title: '物流/送货进度',
    patterns: [
      { type: 'kw', value: '物流' },
      { type: 'kw', value: '送货' },
      { type: 'kw', value: '发货' },
      { type: 'kw', value: '快递' }
    ],
    replyText: '{{客户名}}好，我看一下物流/送货进度，确认后回您具体安排。',
    riskLevel: 'A',
    priority: 50
  },
  {
    intent: '排车安排',
    title: '排车/送货安排',
    patterns: [
      { type: 'kw', value: '安排车' },
      { type: 'kw', value: '拖挂' },
      { type: 'kw', value: '明天送' },
      { type: 'kw', value: '什么时候送' }
    ],
    replyText: '收到，我记下送货安排，跟物配确认车辆与时间后回复您。',
    riskLevel: 'A',
    priority: 60
  },
  {
    intent: '催单',
    title: '催单',
    patterns: [
      { type: 'kw', value: '催一下' },
      { type: 'kw', value: '催催' },
      { type: 'kw', value: '还没收到' },
      { type: 'kw', value: '怎么还没' }
    ],
    replyText: '抱歉让您久等，我马上催一下，有结果立刻回您。',
    riskLevel: 'A',
    priority: 70
  },
  {
    intent: '营业时间',
    title: '营业/发货时间',
    patterns: [
      { type: 'kw', value: '几点上班' },
      { type: 'kw', value: '营业时间' },
      { type: 'kw', value: '几点下班' }
    ],
    replyText: '我们的工作时间是每天 8:30–18:00，节假日照常接单，有急事您直接 @ 我。',
    riskLevel: 'A',
    priority: 80
  },
  {
    intent: '收到确认',
    title: '客户确认信息（只回执不展开）',
    patterns: [
      { type: 'kw', value: '确认一下' },
      { type: 'kw', value: '核对' }
    ],
    replyText: '收到，我核对一下，有问题马上跟您说。',
    riskLevel: 'A',
    priority: 90
  },
  {
    intent: '价格优惠',
    title: '价格 / 优惠 / 账期（需确认）',
    patterns: [
      { type: 'kw', value: '便宜' },
      { type: 'kw', value: '优惠' },
      { type: 'kw', value: '价格' },
      { type: 'kw', value: '多少钱' },
      { type: 'kw', value: '账期' }
    ],
    replyText: '价格/账期的事我帮您对接负责人确认，稍后给您答复。',
    riskLevel: 'B',
    priority: 10
  },
  {
    intent: '系统下单问题',
    title: '小程序/系统下单异常（真实高频：商品信息空、搜不到、下不了单）',
    patterns: [
      { type: 'kw', value: '搜索不到' },
      { type: 'kw', value: '下不了单' },
      { type: 'kw', value: '商品信息' },
      { type: 'kw', value: '系统问题' },
      { type: 'kw', value: '不能下单' },
      { type: 'kw', value: '打不开' }
    ],
    replyText:
      '{{客户名}}好，下单异常我记下了：麻烦把门店名 + 品名发我一下，我同步技术排查，能下单了第一时间告诉您。',
    riskLevel: 'A',
    priority: 15
  },
  {
    intent: '配件补发',
    title: '配件/耗材补发（灯泡、包装等）',
    patterns: [
      { type: 'kw', value: '灯泡' },
      { type: 'kw', value: '配件' },
      { type: 'kw', value: '包装' },
      { type: 'kw', value: '补发' },
      { type: 'kw', value: '发几个过来' }
    ],
    replyText: '好的，配件/补发的事我确认一下库存和发货安排，稍后回您。',
    riskLevel: 'A',
    priority: 55
  },
  {
    intent: '退款退货',
    title: '退款 / 退货 / 赔付（永不自动）',
    patterns: [
      { type: 'kw', value: '退款' },
      { type: 'kw', value: '退货' },
      { type: 'kw', value: '赔' },
      { type: 'kw', value: '少发' },
      { type: 'kw', value: '错发' },
      { type: 'kw', value: '多付' }
    ],
    replyText: '',
    riskLevel: 'C',
    priority: 1
  },
  {
    intent: '质量投诉',
    title: '质量异议 / 投诉（永不自动）',
    patterns: [
      { type: 'kw', value: '质量' },
      { type: 'kw', value: '投诉' },
      { type: 'kw', value: '变质' },
      { type: 'kw', value: '坏了' },
      { type: 'kw', value: '异物' },
      { type: 'kw', value: '过期' }
    ],
    replyText: '',
    riskLevel: 'C',
    priority: 1
  },
  {
    intent: '合同资质',
    title: '合同 / 资质 / 协议（永不自动）',
    patterns: [
      { type: 'kw', value: '合同' },
      { type: 'kw', value: '协议' },
      { type: 'kw', value: '资质' },
      { type: 'kw', value: '营业执照' }
    ],
    replyText: '',
    riskLevel: 'C',
    priority: 1
  }
]
