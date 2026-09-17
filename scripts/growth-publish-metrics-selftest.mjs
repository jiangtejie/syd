import { buildSync } from 'esbuild'
import { createRequire } from 'module'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

/**
 * 发布登记校验与合计自检（纯函数）。
 *
 * 为什么值得单测：这是「用户手填数字」的唯一入口，录错一个数量级会直接污染素材分与 ROI；
 * 而在此之前**根本没有这个入口**（只有 AI 对话工具能登记，看板空态还指引去点一个不存在的按钮）。
 */

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'dsh-publish-metrics-'))

let failed = 0
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  ✔ ' : '  ✖ ') + label + (extra ? ' — ' + extra : ''))
  if (!cond) failed++
}

try {
  const bundle = join(work, 'publishMetrics.cjs')
  buildSync({
    entryPoints: [join(root, 'src/main/services/growth/publisher/publishMetrics.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: bundle
  })
  const { parsePublishMetrics, metricTotals, channelLabel, MAX_COUNT } = require(bundle)

  const P = (input) => parsePublishMetrics(input)

  console.log('正常登记：')
  const r1 = P({ channel: 'wxMoments', likes: '12', collects: 3, follows: '5', leads: '2', amount: '199.5' })
  ok(r1.ok === true, '合法输入通过')
  ok(r1.ok && r1.value.likes === 12 && r1.value.collects === 3, '数字原样保留')
  ok(r1.ok && r1.value.amount === 199.5, '金额支持小数', r1.ok ? String(r1.value.amount) : '')
  ok(r1.ok && r1.value.channel === 'wxMoments', '渠道保留')
  ok(r1.ok && r1.value.comments === 0, '没填的项按 0 计')
  const r2 = P({ channel: 'wxGroup', likes: 12.7 })
  ok(r2.ok && r2.value.likes === 13, '计数类四舍五入', r2.ok ? String(r2.value.likes) : '')
  const r3 = P({ channel: 'xhs', amount: '99.999' })
  ok(r3.ok && r3.value.amount === 100, '金额保留两位（99.999 → 100）', r3.ok ? String(r3.value.amount) : '')

  console.log('录入错误必须报错（不能静默吞掉）：')
  const e1 = P({ channel: 'xhs', likes: -1 })
  ok(e1.ok === false && e1.error.includes('点赞') && e1.error.includes('负数'), '负数被拒且指出字段', e1.ok ? '' : e1.error)
  const e2 = P({ channel: 'xhs', leads: 'abc' })
  ok(e2.ok === false && e2.error.includes('线索'), '非数字被拒', e2.ok ? '' : e2.error)
  const e3 = P({ channel: 'xhs', comments: MAX_COUNT + 1 })
  ok(e3.ok === false && e3.error.includes('异常'), '超上限被判数值异常', e3.ok ? '' : e3.error)
  const e4 = P({ channel: 'xhs' })
  ok(e4.ok === false && e4.error.includes('至少填写一项'), '全空被拒（否则会写一堆零快照污染列表）')
  const e5 = P({ channel: 'xhs', likes: 0, amount: 0 })
  ok(e5.ok === false, '显式填 0 也不算有效登记')
  const e6 = P({ channel: 'x'.repeat(33), likes: 1 })
  ok(e6.ok === false && e6.error.includes('过长'), '渠道名过长被拒')

  console.log('宽松与默认：')
  const d1 = P({ likes: 1 })
  ok(d1.ok && d1.value.channel === 'other', '没给渠道 → other')
  const d2 = P({ channel: '  wxChat  ', likes: 1 })
  ok(d2.ok && d2.value.channel === 'wxChat', '渠道两侧空白去掉')
  const d3 = P({ channel: 'bilibili', likes: 1 })
  ok(d3.ok && d3.value.channel === 'bilibili', '未知渠道不拦（历史/新平台都要能写进来）')
  ok(channelLabel('wxMoments') === '微信朋友圈', '已知渠道有中文名')
  ok(channelLabel('bilibili') === 'bilibili', '未知渠道原样显示（不显示成空白）')
  ok(channelLabel('') === '', '空渠道安全')

  console.log('归因产出：')
  const o1 = P({ channel: 'xhs', likes: 1, outputId: 7 })
  ok(o1.ok && o1.value.outputId === 7, '合法产出 id 保留')
  const o2 = P({ channel: 'xhs', likes: 1, outputId: 0 })
  ok(o2.ok && o2.value.outputId === undefined, '0 视为不指定')
  const o3 = P({ channel: 'xhs', likes: 1, outputId: 'abc' })
  ok(o3.ok && o3.value.outputId === undefined, '非法产出 id 视为不指定')
  const o4 = P({ channel: 'xhs', likes: 1, outputId: -3 })
  ok(o4.ok && o4.value.outputId === undefined, '负数产出 id 视为不指定')

  console.log('合计：')
  const totals = metricTotals([
    { likes: 10, collects: 1, comments: 2, shares: 3, follows: 4, leads: 1, amount: 100.1 },
    { likes: 5, collects: 0, comments: 0, shares: 0, follows: 1, leads: 2, amount: 200.2 }
  ])
  ok(totals.count === 2, '次数正确')
  ok(totals.likes === 15 && totals.follows === 5 && totals.leads === 3, '各项求和')
  ok(totals.amount === 300.3, '金额求和并保留两位', String(totals.amount))
  const empty = metricTotals([])
  ok(empty.count === 0 && empty.amount === 0 && empty.leads === 0, '空列表安全（全零，不 NaN）')
  const messy = metricTotals([{ likes: null, leads: undefined, amount: 'x' }])
  ok(messy.likes === 0 && messy.leads === 0 && messy.amount === 0, '脏值当 0（历史数据可能缺列）')
} finally {
  try { rmSync(work, { recursive: true, force: true }) } catch { /* Windows 偶发占用 */ }
}

console.log(failed === 0 ? '\n全部通过 ✅' : '\n' + failed + ' 项失败 ❌')
process.exit(failed === 0 ? 0 : 1)
