#!/usr/bin/env node
/**
 * 意图识别自检(纯函数、零依赖、不联网):
 *   node --experimental-strip-types scripts/intent-selftest.mjs
 *
 * 为什么单独立一套:意图列错了不会报错,只会让复盘统计悄悄失真 ——
 * 「客户到底在问什么」这种结论一旦错,后面所有运营判断都跟着错。
 * 这里用真实群里的说法把「强特征/弱特征/否定词/兜底」全钉住。
 */
import {
  INTENT_FALLBACK,
  builtinIntentLabels,
  classifyByRules,
  normalizeIntentText
} from '../src/main/services/agent/intentLexicon.ts'

let failed = 0
const log = (ok, name, detail) => {
  if (!ok) failed++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`)
}

console.log('\n[1] 归一化(全角/空白/大小写)')
log(normalizeIntentText('发　票') === '发 票', '全角空格被归一', JSON.stringify(normalizeIntentText('发　票')))
log(normalizeIntentText('ＡＢＣ') === 'abc', '全角字母转半角 + 小写', normalizeIntentText('ＡＢＣ'))
log(normalizeIntentText('  到货 了没 ') === '到货 了没', '去首尾空白并折叠中间空白')

console.log('\n[2] 清晰问法 → 正确标签 + 高置信')
const clear = [
  ['孜然粉到货了没', '到货时间'],
  ['这批鸡爪什么时候到', '到货时间'],
  ['缺的货先发一部分', '缺货先发'],
  ['发票开好了吗', '发票进度'],
  ['帮我开个专票', '发票进度'],
  ['这个月对账单发我一下', '对账单/单据'],
  ['物流到哪了', '物流查询'],
  ['单号给我一下', '物流查询'],
  ['明天能排车吗', '排车安排'],
  ['帮我催一下', '催单'],
  ['你们几点开门', '营业时间'],
  ['价格能不能再优惠点', '价格优惠'],
  ['系统下单上不去', '系统下单问题'],
  ['少了一件配件，麻烦补发', '配件补发'],
  ['这单我要退款', '退款退货'],
  ['货到了都是坏的，我要投诉', '质量投诉'],
  ['营业执照和检疫报告发我', '合同资质']
]
for (const [text, want] of clear) {
  const hit = classifyByRules(text)
  const ok = hit && hit.intent === want && hit.confidence >= 0.7
  log(ok, `「${text}」→ ${want}`, hit ? `${hit.intent} (${hit.confidence}) 证据:${hit.evidence.join('/')}` : 'null')
}

console.log('\n[3] 容易串的写法:否定词与竞争标签要能把分拉回来')
const confusing = [
  ['发票到了吗', '发票进度'],
  ['对账单上的单号写错了', '对账单/单据'],
  ['退款能退到哪张卡', '退款退货'],
  ['车到哪了，司机电话给我', '物流查询']
]
for (const [text, want] of confusing) {
  const hit = classifyByRules(text)
  log(hit?.intent === want, `「${text}」→ ${want}`, hit ? `${hit.intent} (${hit.confidence})` : 'null')
}

console.log('\n[4] 每条判定都要有证据')
for (const [text] of clear.slice(0, 5)) {
  const hit = classifyByRules(text)
  log(!!hit && hit.evidence.length > 0, `「${text}」有命中词`, hit?.evidence.join('/'))
}

console.log('\n[5] 拿不准/无关的文本 → null(交给上层兜底成「其他」)')
log(classifyByRules('今天天气不错') === null, '与业务无关 → null')
log(classifyByRules('') === null, '空文本 → null')
log(classifyByRules('在') === null, '单字 → null')
log(classifyByRules('[图片]') === null, '非文本占位 → null')
log(classifyByRules('好的收到') === null, '纯应答 → null')
log(INTENT_FALLBACK === '其他', '兜底标签是「其他」(永不返回空串)')

console.log('\n[6] 模糊问法:允许标签落地,但置信度必须低(交给模型复核)')
const vague = ['到货情况怎么样', '这个怎么说', '反正就是不太行']
for (const text of vague) {
  const hit = classifyByRules(text)
  log(!hit || hit.confidence < 0.7, `「${text}」置信度偏低`, hit ? `${hit.intent} (${hit.confidence})` : 'null')
}

console.log('\n[7] 自定义规则(话术库里的意图)可参与竞争')
const custom = [{ intent: '想订新货', strong: ['留两箱新货'], weak: ['留点新货'], negative: [] }]
const customHit = classifyByRules('老板，帮我们留两箱新货', custom)
log(customHit?.intent === '想订新货', '自定义强特征生效', JSON.stringify(customHit))
const shadowed = classifyByRules('孜然粉到货了没', custom)
log(shadowed?.intent === '到货时间', '自定义规则不会盖掉更准的内置判断', JSON.stringify(shadowed))
const labels = builtinIntentLabels()
log(labels.length >= 12, `内置标签 ${labels.length} 个`, labels.join('、'))
log(new Set(labels).size === labels.length, '没有重复标签')

console.log('\n[9] 真实群聊噪声:先清洗再识别(样本取自线上库里的「未归类」记录)')
const noisy = [
  ['成都成华店9.11订单 @亚特物配文员-陈西西 麻烦安排一下，谢谢！', '下单订货'],
  ['门店订货啦 @萍姐物配客服-黄巧-17723603132 收到', '下单订货'],
  ['[图片] @萍姐物配客服-黄巧-17723603132 老师这个鸡爪胀气了 [抱拳] 收到', '质量投诉'],
  ['@萍姐物配客服-黄巧-17723603132 需要配送货物，谢谢', '发货配送'],
  ['货都收到了，电子单开给我哈', '对账单/单据'],
  ['没显示总价呢[呲牙]', '价格优惠'],
  ['2960188524@chatroom: 好', '其他/no-null'],
  ['"亦春" 撤回了一条消息\n"贺玲" 撤回了一条消息', '其他/no-null'],
  ['@客服 需要 等会', '其他/no-null'],
  ['[消息]', '其他/no-null'],
  ['57240698823@chatroom:', '其他/no-null']
];
for (const [text, want] of noisy) {
  const hit = classifyByRules(text)
  if (want === '其他/no-null') {
    log(!hit, `噪声样本文本不该硬判:${JSON.stringify(text.slice(0, 24))}`, hit ? `${hit.intent}(${hit.confidence})` : 'null')
    continue
  }
  log(
    hit?.intent === want,
    `${JSON.stringify(text.slice(0, 26))} → ${want}`,
    hit ? `${hit.intent} (${hit.confidence}) 证据:${hit.evidence.join('/')}` : 'null'
  )
}
log(
  normalizeIntentText('  123@chatroom:  @客服   [图片]  到货了没 ') === '到货了没',
  '清洗后只留正文',
  JSON.stringify(normalizeIntentText('  123@chatroom:  @客服   [图片]  到货了没 '))
)

console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项未通过 ❌`)
process.exit(failed === 0 ? 0 : 1)
