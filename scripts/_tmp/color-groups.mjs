import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
const files = []
function walk(d) { for (const e of readdirSync(d)) { const p = join(d, e); const st = statSync(p); if (st.isDirectory()) { if (['node_modules','.git','out','_tmp'].includes(e)) continue; walk(p) } else if (e.endsWith('.css')) files.push(p) } }
walk('src/renderer/src')
const counts = new Map()
for (const f of files) { const t = readFileSync(f, 'utf8'); const re = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g; let m; while ((m = re.exec(t))) counts.set(m[0], (counts.get(m[0]) || 0) + 1) }
const groups = { hex: [], white: [], black: [], brand: [], other: [] }
for (const [v, n] of counts) {
  if (v.startsWith('#')) groups.hex.push([v, n])
  else if (/rgba\(255, 255, 255/.test(v)) groups.white.push([v, n])
  else if (/rgba\(0, 0, 0/.test(v)) groups.black.push([v, n])
  else if (/rgba\(7, 193, 96/.test(v)) groups.brand.push([v, n])
  else groups.other.push([v, n])
}
for (const [k, arr] of Object.entries(groups)) {
  arr.sort((a, b) => b[1] - a[1])
  console.log('==== ' + k + ' (' + arr.length + ' 个值 / ' + arr.reduce((s, x) => s + x[1], 0) + ' 次)')
  console.log(arr.map(([v, n]) => v + '×' + n).join('  '))
}
