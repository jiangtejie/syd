#!/usr/bin/env node
/**
 * 列表/详情选中规则自检（纯函数、零依赖）：
 *   node --experimental-strip-types scripts/monitor-selection-selftest.mjs
 *
 * 规则错了不会报错，只会让人「点完处理没反应」—— 问题监控就踩过这个坑，所以用断言钉住。
 */
import { nextSelection } from '../src/renderer/src/lib/selection.ts'

let failed = 0
const log = (ok, name, detail) => {
  if (!ok) failed++
  console.log(`${ok ? '  ok  ' : 'FAIL '} ${name}${detail ? ' — ' + detail : ''}`)
}
const it = (id, status) => ({ id, status })
const base = { loading: false, userFiltered: false }

console.log('\n[1] 处置后自动推进到下一条（本次要修的 bug）')
const list1 = [it(2, 'open'), it(3, 'open')]
const a1 = nextSelection({ ...base, active: it(1, 'done'), list: list1 })
log(a1.kind === 'select' && a1.item.id === 2, '选中的 #1 已离开列表 → 切到最前面的 #2', JSON.stringify(a1))
log(
  nextSelection({ ...base, active: it(2, 'open'), list: list1 }).kind === 'keep',
  '选中的 #2 还在列表里 → 不动（不打断正在处理的人）'
)

console.log('\n[2] 列表空了要收起详情，而不是继续显示一条不在列表里的问题')
const a2 = nextSelection({ ...base, active: it(1, 'done'), list: [] })
log(a2.kind === 'clear', '列表空 + 有选中 → 清空详情', JSON.stringify(a2))
log(
  nextSelection({ ...base, active: null, list: [] }).kind === 'keep',
  '列表空 + 没选中 → 什么都不做（避免无意义重渲染）'
)

console.log('\n[3] 加载中不做判断')
log(
  nextSelection({ ...base, loading: true, active: it(1, 'open'), list: [] }).kind === 'keep',
  'loading=true → 保持，避免拿半截数据把选中项清掉'
)

console.log('\n[4] 首屏默认选中第一条，但用户自己加了筛选就不打扰')
log(
  nextSelection({ ...base, active: null, list: [it(1, 'open'), it(2, 'open')] }).item?.id === 1,
  '无选中+无筛选 → 默认第一条'
)
log(
  nextSelection({ ...base, userFiltered: true, active: null, list: [it(1, 'open')] }).kind === 'keep',
  '无选中+有筛选 → 不主动跳'
)
log(
  nextSelection({ ...base, userFiltered: true, active: it(9, 'open'), list: [it(1, 'open')] }).kind ===
    'select',
  '有选中但被筛掉了 → 仍然推进（这正是处置后的场景）'
)

console.log('\n[5] 边界：选中项恰好就是第一条 / 列表里同一个 id')
log(
  nextSelection({ ...base, active: it(1, 'open'), list: [it(1, 'open'), it(2, 'open')] }).kind === 'keep',
  '选中第一条 → 不动（否则会重复拉详情）'
)

console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项未通过 ❌`)
process.exit(failed === 0 ? 0 : 1)
