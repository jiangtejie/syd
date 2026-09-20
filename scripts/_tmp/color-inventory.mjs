import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'
const root = '.'
const files = []
function walk(d) { for (const e of readdirSync(d)) { const p = join(d, e); const st = statSync(p); if (st.isDirectory()) { if (['node_modules','.git','out','_tmp'].includes(e)) continue; walk(p) } else if (e.endsWith('.css')) files.push(p) } }
walk('src/renderer/src')
const counts = new Map()
const byFile = new Map()
for (const f of files) {
  const t = readFileSync(f, 'utf8')
  const re = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g
  let m
  while ((m = re.exec(t))) {
    const v = m[0]
    counts.set(v, (counts.get(v) || 0) + 1)
    if (!byFile.has(v)) byFile.set(v, new Set())
    byFile.get(v).add(f.replace('src/renderer/src/', ''))
  }
}
const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
console.log('唯一颜色值 ' + sorted.length + ' 个，总出现 ' + [...counts.values()].reduce((a, b) => a + b, 0) + ' 次')
for (const [v, n] of sorted) {
  if (n < 2) continue
  console.log(String(n).padStart(3) + '  ' + v.padEnd(34) + '  ' + [...byFile.get(v)].slice(0, 4).join(','))
}
console.log('--- 只出现一次的值：' + sorted.filter(([, n]) => n === 1).length + ' 个')
