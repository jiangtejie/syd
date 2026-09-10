#!/usr/bin/env node
/**
 * 文本降噪回归自检(零依赖):
 *   node --experimental-strip-types scripts/text-filters-selftest.mjs
 *
 * 用例来自线上真实样本:采购群里「收到」「发票请查收」「快递单号」被建成客户议题。
 */
import {
  isAckOnly,
  isTransactionalNotice,
  shouldSkipAsNoise
} from '../src/main/services/feedback/textFilters.ts'

let failed = 0
const log = (ok, name, detail) => {
  if (!ok) failed++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`)
}
const skip = (text, expect) => log(shouldSkipAsNoise(text) === expect, `${expect ? '过滤' : '保留'}: "${text}"`)

console.log('\n[1] 纯应答/寒暄 → 过滤')
for (const t of ['收到', '好的', '好滴', '嗯嗯', '谢谢', '谢谢老板', '好的谢谢', '辛苦了', 'OK', 'ok', '麻烦了']) {
  log(isAckOnly(t), `ack: ${t}`)
}

console.log('\n[2] 事务性通知 → 过滤（线上实测样本）')
for (const t of ['发票请查收', '993537764   钟小飞   10件快运单号以上', '以上是物料发货明细，麻烦收到货请回复', '开票资料已发群里', '这是本周对账单', '收货确认：冻货共2件']) {
  log(isTransactionalNotice(t), `notice: ${t}`)
}

console.log('\n[3] 真实诉求 → 必须保留（不能误伤）')
for (const t of ['这个单子还没收到？', '我的快递单号 993537 显示签收但没收到', '发票开错了要重开', '什么时候发货', '客户催要火腿猪肉罐头20件', '少发了2袋怎么处理']) {
  skip(t, false)
}

console.log('\n[4] 带抱怨信号的通知 → 保留（可能真诉求）')
log(!isTransactionalNotice('发票请查收但金额不对'), 'notice+complaint')
log(!isTransactionalNotice('单号 123456 的货少了2件'), 'notice+short')

console.log('\n[5] 长文本不应被判成纯应答')
log(!isAckOnly('收到货了但是少了两袋麻烦看一下'), 'long not ack')

console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项未通过 ❌`)
process.exit(failed === 0 ? 0 : 1)
