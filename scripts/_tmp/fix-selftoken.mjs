import { readFileSync, writeFileSync } from 'fs'
const f = 'src/renderer/src/assets/base.css'
let t = readFileSync(f, 'utf8')
// 回滚"自我引用"的令牌定义：收口脚本把 --x: #hex 里的值也换成了 var(--x)
const FIX = [
  ['--text-1: var(--text-1);', '--text-1: #1f2329;'],
  ['--border-light: var(--border-light);', '--border-light: #eef0f3;'],
  ['--text-strong: var(--text-strong);', '--text-strong: #1a1a1a;'],
  ['--placeholder: var(--placeholder);', '--placeholder: #b0b6bf;'],
  ['--border-strong: var(--border-strong);', '--border-strong: #d9dce1;'],
  ['--bg-sunken: var(--bg-sunken);', '--bg-sunken: #f7f8fa;'],
  ['--danger-text: var(--danger-text);', '--danger-text: #c92a2a;'],
  ['--warn-strong: var(--warn-strong);', '--warn-strong: #b8860b;'],
  ['--hover-sheen: var(--hover-sheen);', '--hover-sheen: rgba(255, 255, 255, 0.7);'],
  ['--badge-sheen: var(--badge-sheen);', '--badge-sheen: rgba(255, 255, 255, 0.5);'],
  ['--brand-2: var(--brand-2);', '--brand-2: #10d473;'],
  ['--brand-3: var(--brand-3);', '--brand-3: #07a84f;']
]
let n = 0
for (const [from, to] of FIX) { const c = t.split(from).length - 1; if (c) { t = t.split(from).join(to); n += c } }
writeFileSync(f, t)
console.log('修回 ' + n + ' 条自我引用令牌')
// 全仓再扫一次：不该再有 --x: var(--x)
import { readdirSync, statSync } from 'fs'
import { join } from 'path'
const files = []
function walk(d) { for (const e of readdirSync(d)) { const p = join(d, e); const st = statSync(p); if (st.isDirectory()) { if (['node_modules','.git','out','_tmp'].includes(e)) continue; walk(p) } else if (e.endsWith('.css')) files.push(p) } }
walk('src/renderer/src')
let selfRef = 0
for (const file of files) {
  const s = readFileSync(file, 'utf8')
  const m = s.match(/(--[a-z0-9-]+):\s*var\(\1\)/g)
  if (m) { selfRef += m.length; console.log('  自我引用: ' + file + ' → ' + m.join(', ')) }
}
console.log('剩余自我引用: ' + selfRef)
