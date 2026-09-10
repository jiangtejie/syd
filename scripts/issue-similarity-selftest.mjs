#!/usr/bin/env node
/**
 * issueSimilarity 判据回归自检(零依赖):
 *   node --experimental-strip-types scripts/issue-similarity-selftest.mjs
 *
 * 用例数值全部来自真实库标定(37 条 open / 95 组配对,见提交 98cfeda):
 * 判据一旦被改动,先在这里红/绿,避免「悄悄把两个主题并成一条」这类回归。
 */
import {
  topicSame,
  titleSimilarity,
  clusterTopics
} from '../src/main/services/feedback/issueSimilarity.ts'

let failed = 0
const log = (ok, name, detail) => {
  if (!ok) failed++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`)
}
const same = (name, a, b, expect, expectStrong) => {
  const m = topicSame(a, b)
  log(m.same === expect, name, `same=${m.same} strong=${m.strong} ${m.reason}`)
  if (expectStrong !== undefined) log(m.strong === expectStrong, name + ' [strong]', String(m.strong))
}
const facts = (o) => ({ usernames: [], ...o })

console.log('\n[1] 同一议题:标题逐字一致 + 证据几乎全同 → 可自动合并')
same(
  'identical title',
  facts({ title: '订单缺货客户要求等货齐一起发', type: '其他', customers: ['亦春'], evidenceTimes: [1, 2, 3, 4, 5], occurAt: 1000 }),
  facts({ title: '订单缺货客户要求等货齐一起发', type: '其他', customers: ['亦春'], evidenceTimes: [1, 2, 3, 4, 6], occurAt: 1000 + 6e5 }),
  true,
  true
)

console.log('\n[2] 同一议题:措辞相近(0.64) + 同客户 + 共享 4 条 → 可自动合并')
same(
  'near title 0.64',
  facts({ title: '梦想断货催促物流送货', type: '物流', customers: ['梦想'], evidenceTimes: [1, 2, 3, 4], occurAt: 1000 }),
  facts({ title: '客户断货催促物流送货', type: '物流', customers: ['梦想'], evidenceTimes: [1, 2, 3, 5], occurAt: 1000 + 6e5 }),
  true,
  true
)

console.log('\n[3] 长跨度同题(实测跨 15.5 小时):标题 0.64 + 共享 2 → 仍可自动合并')
same(
  'long span',
  facts({ title: '德邦发货件数核对', type: '物流', customers: ['德邦'], evidenceTimes: [1, 2, 3, 4], occurAt: 1000 }),
  facts({ title: '德邦发货件数核对与找回件', type: '物流', customers: ['德邦'], evidenceTimes: [3, 4, 9, 10], occurAt: 1000 + 932 * 6e4 }),
  true,
  true
)

console.log('\n[4] 反例:两个主题共享 4 条证据(覆盖 0.67)但不同类型 → 绝不能并')
same(
  'cross-theme',
  facts({ title: '订单缺货客户要求等货齐一起发', type: '其他', customers: ['亦春'], evidenceTimes: [1, 2, 3, 4, 5, 6], occurAt: 1000 }),
  facts({ title: '牛心管缺货多付4袋钱退款', type: '售后', customers: ['亦春'], evidenceTimes: [1, 2, 3, 5, 7, 8], occurAt: 1000 + 8e5 }),
  false
)

console.log('\n[5] 规则行(标题是原文摘录) vs LLM 概括:标题仅 0.2,靠同客户+同类型+证据包含')
same(
  'llm vs rule',
  facts({ title: '牛心管缺货多付4袋钱退款', type: '售后', customers: ['亦春'], evidenceTimes: [11, 12, 13], occurAt: 1000 }),
  facts({ title: '亦春：多付的4袋钱走流程退款吧', type: '售后', customers: ['亦春'], evidenceTimes: [11], occurAt: 1000 + 14 * 6e4 }),
  true,
  true
)

console.log('\n[6] 只有时间邻近(同客户同类型 3 分钟) → 算同题但**不可自动合并**')
same(
  'weak time-only',
  facts({ title: '客户断货催促物流送货', type: '物流', customers: ['梦想'], evidenceTimes: [21, 22], occurAt: 1000 }),
  facts({ title: '梦想缺货商品下架需补货或物流安排', type: '物流', customers: ['梦想'], evidenceTimes: [31, 32], occurAt: 1000 + 3 * 6e4 }),
  true,
  false
)

console.log('\n[7] 反例:不同客户问法雷同(标题相似但无身份、无证据交集) → 不能并')
const t7 = titleSimilarity('鸡爪今日能否到货咨询', '鸭脖今日能否到货咨询')
same(
  'two customers same phrasing',
  facts({ title: '鸡爪今日能否到货咨询', type: '物流', customers: ['甲店'], evidenceTimes: [41, 42], occurAt: 1000 }),
  facts({ title: '鸭脖今日能否到货咨询', type: '物流', customers: ['乙店'], evidenceTimes: [51, 52], occurAt: 1000 + 6e4 }),
  false
)
log(t7 >= 0.4, 'guard case is really title-similar', `titleSim=${t7.toFixed(2)}`)

console.log('\n[8] 聚类:三行同一议题聚成一组且标记 strong')
const cl = clusterTopics([
  facts({ title: '孜然粉到货咨询及缺2袋补发', type: '咨询', customers: ['甲'], evidenceTimes: [1, 2, 3, 4], occurAt: 1 }),
  facts({ title: '孜然粉到货咨询未回复', type: '咨询', customers: ['甲'], evidenceTimes: [1, 2, 3, 4], occurAt: 2 }),
  facts({ title: '孜然粉到货咨询及缺2袋补发', type: '咨询', customers: ['甲'], evidenceTimes: [1, 2, 3, 4], occurAt: 3 })
])
log(cl.length === 1 && cl[0].members.length === 3, 'cluster size', JSON.stringify(cl.map((c) => c.members.length)))
log(cl[0]?.strong === true, 'cluster strong', String(cl[0]?.strong))

console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项未通过 ❌`)
process.exit(failed === 0 ? 0 : 1)
