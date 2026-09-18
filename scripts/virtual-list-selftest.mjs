import { buildSync } from 'esbuild'
import { createRequire } from 'module'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

/**
 * 会话列表窗口化自检（纯函数）。
 *
 * 窗口化算错的后果不是报错，而是**列表显示错位**：行重复、行丢失、滚动条长度不对、
 * 滚到底部出现空白 —— 这些在有限的手测里很可能只表现为「有时候怪怪的」。
 * 所以这里把四条不变量钉死：
 *  ① 切片不越界、end ≥ start（除非空列表）；
 *  ② padTop + 渲染行数×行高 + padBottom === 总高度（页面不会多出/少掉高度）；
 *  ③ 渲染行数有上界（这正是它存在的意义：1000 行也只渲染十几行）；
 *  ④ 视口内的行一定被覆盖（不能因为起止算错把可见行漏掉）。
 */

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'dsh-virtual-list-'))

let failed = 0
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  ✔ ' : '  ✖ ') + label + (extra ? ' — ' + extra : ''))
  if (!cond) failed++
}

try {
  const bundle = join(work, 'virtualList.cjs')
  buildSync({
    entryPoints: [join(root, 'src/renderer/src/lib/virtualList.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle
  })
  const { virtualWindow } = require(bundle)
  const ROW = 46
  const VIEW = 460
  const OVER = 4

  console.log('空列表：')
  const empty = virtualWindow({ scrollTop: 0, viewportH: VIEW, rowH: ROW, total: 0 })
  ok(empty.start === 0 && empty.end === 0 && empty.padTop === 0 && empty.padBottom === 0, '空列表不渲染任何行')

  console.log('不变量（各种滚动位置都成立）：')
  const cases = [0, 1, 45, 46, 47, 500, 1000, 99999, -10, NaN]
  let allInside = true
  let allHeightOk = true
  let allCover = true
  let maxRendered = 0
  const TOTAL = 1000
  const contentH = TOTAL * ROW
  for (const st of cases) {
    const w = virtualWindow({ scrollTop: st, viewportH: VIEW, rowH: ROW, total: TOTAL, overscan: OVER })
    if (!(w.start >= 0 && w.end <= TOTAL && w.end >= w.start)) allInside = false
    if (w.padTop + (w.end - w.start) * ROW + w.padBottom !== contentH) allHeightOk = false
    maxRendered = Math.max(maxRendered, w.end - w.start)
    const top = Math.min(Math.max(0, Number.isFinite(st) ? st : 0), contentH - VIEW)
    const firstVisible = Math.floor(top / ROW)
    const lastVisible = Math.min(TOTAL - 1, Math.ceil((top + VIEW) / ROW) - 1)
    if (!(firstVisible >= w.start && lastVisible <= w.end - 1)) allCover = false
  }
  ok(allInside, '切片始终落在 [0, total] 内且 end ≥ start')
  ok(allHeightOk, 'padTop + 渲染行数×行高 + padBottom === 内容总高（滚动条长度不会错）')
  ok(allCover, '视口内可见的行一定在切片里（不会漏行）')
  ok(maxRendered <= Math.ceil(VIEW / ROW) + 2 * OVER + 1, '渲染行数有上界', String(maxRendered) + ' 行')

  console.log('窗口化确实生效：')
  const top = virtualWindow({ scrollTop: 0, viewportH: VIEW, rowH: ROW, total: TOTAL, overscan: OVER })
  ok(top.start === 0 && top.padTop === 0, '在顶部时上方无占位')
  ok(top.end - top.start <= 16, '1000 行只渲染十余行', String(top.end - top.start))
  const mid = virtualWindow({ scrollTop: 4600, viewportH: VIEW, rowH: ROW, total: TOTAL, overscan: OVER })
  ok(mid.start > 0 && mid.padBottom > 0, '滚到中间时上下都有占位')
  ok(mid.padTop === mid.start * ROW, 'padTop 与起始下标一致')
  const bottom = virtualWindow({ scrollTop: contentH - VIEW, viewportH: VIEW, rowH: ROW, total: TOTAL, overscan: OVER })
  ok(bottom.end === TOTAL && bottom.padBottom === 0, '滚到底部时结束于末行、下方无占位')

  console.log('防御（脏输入不该把列表算坏）：')
  const dirty = virtualWindow({ scrollTop: 'abc', viewportH: null, rowH: ROW, total: 100 })
  ok(dirty.start === 0 && dirty.end >= 1, '脏 scrollTop/viewportH 按 0 处理', JSON.stringify(dirty))
  const scrollPast = virtualWindow({ scrollTop: 999999, viewportH: VIEW, rowH: ROW, total: 100 })
  ok(scrollPast.end === 100, '滚动位置超出内容时夹到末尾')
  const shortContent = virtualWindow({ scrollTop: 0, viewportH: 10000, rowH: ROW, total: 3 })
  ok(shortContent.start === 0 && shortContent.end === 3 && shortContent.padBottom === 0, '内容比视口短时全部渲染')
  ok(virtualWindow({ scrollTop: 0, viewportH: VIEW, rowH: 0, total: 5 }).end === 5, '行高为 0 不除零（按 1 处理）')
  ok(virtualWindow({ scrollTop: 0, viewportH: VIEW, rowH: ROW, total: -5 }).end === 0, '负数总数按空列表')
} finally {
  try {
    rmSync(work, { recursive: true, force: true })
  } catch {
    /* Windows 偶发占用 */
  }
}

console.log(failed === 0 ? '\n全部通过 ✅' : '\n' + failed + ' 项失败 ❌')
process.exit(failed === 0 ? 0 : 1)
