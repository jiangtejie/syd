#!/usr/bin/env node
/**
 * 工具调用时间线的编排自检（纯函数，零依赖）：
 *   node --experimental-strip-types scripts/tool-timeline-selftest.mjs
 *
 * 为什么值得钉死：「这一步是顺序还是并行」只靠一条规则（调用区间是否重叠）判定，
 * 判错了 UI 就会把并行画成串行（或反过来），而肉眼看不出是数据错还是画错。
 */
import {
  buildTimelineSteps,
  fmtDuration,
  itemDurationMs,
  splitToolRuns,
  stepTitle,
  timelineSummary
} from '../src/renderer/src/lib/toolTimeline.ts'

let failed = 0
const log = (ok, name, detail) => {
  if (!ok) failed++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`)
}

const T = 1_000_000

console.log('\n[1] 串行：区间不重叠 → 一步一个节点')
const seq = buildTimelineSteps([
  { id: 1, name: 'query_issues', status: 'done', startedAt: T, endedAt: T + 1000 },
  { id: 2, name: 'monitor_summary', status: 'done', startedAt: T + 1000, endedAt: T + 1800 },
  { id: 3, name: 'send_message', status: 'done', startedAt: T + 2000, endedAt: T + 2500 }
])
log(seq.length === 3, '3 次调用 → 3 步', String(seq.length))
log(!seq.some((s) => s.parallel), '没有并行标记')
log(seq.every((s) => s.items.length === 1), '每步一个调用')

console.log('\n[2] 并行：区间重叠 → 同一步里的多个节点')
const par = buildTimelineSteps([
  { id: 1, name: 'query_issues', status: 'done', startedAt: T, endedAt: T + 3000 },
  { id: 2, name: 'monitor_summary', status: 'done', startedAt: T + 200, endedAt: T + 1500 },
  { id: 3, name: 'search', status: 'done', startedAt: T + 4000, endedAt: T + 4500 }
])
log(par.length === 2, '两个重叠 + 一个独立 → 2 步', String(par.length))
log(par[0].parallel && par[0].items.length === 2, '第一步是并行(2 个)')
log(!par[1].parallel, '第二步是串行')
log(par[0].endAt === T + 3000, '整步结束时间取并集最晚', String(par[0].endAt - T))

console.log('\n[3] 进行中：没有结束时间时用 now 判定重叠')
const now = T + 5000
const running = buildTimelineSteps(
  [
    { id: 1, name: 'slow_tool', status: 'start', startedAt: T },
    { id: 2, name: 'fast_tool', status: 'done', startedAt: T + 1000, endedAt: T + 1200 }
  ],
  now
)
log(running.length === 1 && running[0].parallel, '进行中的调用与后来的调用判为并行')
log(timelineSummary(running, now).running === 1, '摘要里 1 个进行中')

console.log('\n[4] 历史行没有时间戳 → 一律按串行')
const noTime = buildTimelineSteps([
  { id: 1, name: 'a', status: 'done' },
  { id: 2, name: 'b', status: 'done' },
  { id: 3, name: 'c', status: 'fail' }
])
log(noTime.length === 3 && !noTime.some((s) => s.parallel), '3 步、无并行')
log(noTime[2].items[0].status === 'fail', '失败状态保留')

console.log('\n[5] 摘要与耗时文案')
const sum = timelineSummary(seq, T + 10_000)
log(sum.calls === 3 && sum.steps === 3, '调用数/步数', `${sum.calls}/${sum.steps}`)
log(sum.durationMs === 2500, '整段耗时 = 首末区间', String(sum.durationMs))
log(sum.failed === 0 && sum.running === 0, '无失败无进行中')
log(fmtDuration(800) === '0.8s', '<10s 带一位小数', fmtDuration(800))
log(fmtDuration(3400) === '3.4s', '3.4s', fmtDuration(3400))
log(fmtDuration(12_500) === '13s', '≥10s 取整', fmtDuration(12_500))
log(fmtDuration(63_000) === '1m03s', '≥60s 用 m+补零秒', fmtDuration(63_000))
log(itemDurationMs({ id: 1, name: 'x', status: 'start', startedAt: T }, T + 1500) === 1500, '进行中 = 到 now')
log(stepTitle(seq[0]) === 'query_issues', '单调用步标题用工具名')
log(stepTitle(par[0]) === '2 个调用并行', '并行步标题', stepTitle(par[0]))

console.log('\n[6] 相邻工具行合并（历史消息逐条存 tool_call）')
const rows = [
  { id: 1, isTool: false },
  { id: 2, isTool: true },
  { id: 3, isTool: true },
  { id: 4, isTool: false },
  { id: 5, isTool: true }
]
const runs = splitToolRuns(rows)
log(runs.length === 4, '分成 4 段', String(runs.length))
log(runs[1].tool && runs[1].rows.length === 2, '中间两行并成一段')
log(!runs[0].tool && runs[0].row.id === 1, '非工具行原样返回')
log(runs[3].tool && runs[3].rows.length === 1, '结尾单独一行也成段')
log(splitToolRuns([]).length === 0, '空输入 → 空结果')
log(
  splitToolRuns([{ id: 9, isTool: true }])[0].rows.length === 1,
  '只有工具行也能处理'
)

console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项未通过 ❌`)
process.exit(failed === 0 ? 0 : 1)
