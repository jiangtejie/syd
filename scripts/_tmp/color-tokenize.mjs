import { readdirSync, readFileSync, writeFileSync, statSync } from 'fs'
import { join } from 'path'
const files = []
function walk(d) { for (const e of readdirSync(d)) { const p = join(d, e); const st = statSync(p); if (st.isDirectory()) { if (['node_modules','.git','out','_tmp'].includes(e)) continue; walk(p) } else if (e.endsWith('.css')) files.push(p) } }
walk('src/renderer/src')

// 值 → 令牌。令牌的浅色值 = 原值（base.css 里新加的）或与原值肉眼不可分（1~8 级灰阶差）。
const MAP = [
  // 白 / 近白
  ['background: #fff;', 'background: var(--bg-panel);'],
  ['background-color: #fff;', 'background-color: var(--bg-panel);'],
  ['background: #ffffff;', 'background: var(--bg-panel);'],
  ['color: #fff;', 'color: var(--on-brand);'],
  ['color: #ffffff;', 'color: var(--on-brand);'],
  // 中性结构
  ['#1f2329', 'var(--text-1)'],
  ['#1a1a1a', 'var(--text-strong)'],
  ['#b0b6bf', 'var(--placeholder)'],
  ['#d9dce1', 'var(--border-strong)'],
  ['#f7f8fa', 'var(--bg-sunken)'],
  ['#c92a2a', 'var(--danger-text)'],
  ['#b8860b', 'var(--warn-strong)'],
  ['#10d473', 'var(--brand-2)'],
  ['#07a84f', 'var(--brand-3)'],
  // 浅灰（背景/描边）：并入 --bg-hover / --border-light / --border-strong
  ['#f0f2f5', 'var(--bg-hover)'],
  ['#f2f3f5', 'var(--bg-hover)'],
  ['#f1f3f5', 'var(--bg-hover)'],
  ['#f2f4f7', 'var(--bg-hover)'],
  ['#f3f4f6', 'var(--bg-hover)'],
  ['#eceef1', 'var(--bg-hover)'],
  ['#e8eaee', 'var(--border-light)'],
  ['#eef0f3', 'var(--border-light)'],
  ['#e5e7eb', 'var(--border-light)'],
  ['#d8dce1', 'var(--border-light)'],
  ['#dfe2e7', 'var(--border-strong)'],
  ['#dfe3e9', 'var(--border-strong)'],
  ['#d6dae1', 'var(--border-strong)'],
  ['#cfd4da', 'var(--border-strong)'],
  ['#cfd4db', 'var(--border-strong)'],
  // 中灰（次要文字）：按明度并入 --text-3 / --text-4
  ['#9aa0a6', 'var(--text-3)'],
  ['#a8adb5', 'var(--text-3)'],
  ['#aaa', 'var(--text-3)'],
  ['#aab0ba', 'var(--text-4)'],
  ['#b6bcc6', 'var(--text-4)'],
  ['#b0b7c3', 'var(--text-4)'],
  ['#b0b3b8', 'var(--text-4)'],
  // 深灰（正文/标题文字）
  ['#57606e', 'var(--text-2)'],
  ['#5b626b', 'var(--text-2)'],
  ['#6b7280', 'var(--text-2)'],
  ['#8a919a', 'var(--text-3)'],
  // 交互高光
  ['rgba(255, 255, 255, 0.7)', 'var(--hover-sheen)'],
  ['rgba(255, 255, 255, 0.5)', 'var(--badge-sheen)'],
  // 旧命名令牌（--muted/--panel/--line）也一并收口
  ['var(--muted)', 'var(--text-2)'],
  ['var(--panel)', 'var(--bg-panel)'],
  ['var(--line)', 'var(--border)']
]

let total = 0
const perFile = []
for (const f of files) {
  let t = readFileSync(f, 'utf8')
  const before = t
  let n = 0
  for (const [from, to] of MAP) {
    const c = t.split(from).length - 1
    if (c > 0) { t = t.split(from).join(to); n += c }
  }
  if (t !== before) { writeFileSync(f, t); perFile.push(f.replace('src/renderer/src/', '') + ' ×' + String(n)); total += n }
}
console.log('替换 ' + total + ' 处，涉及 ' + perFile.length + ' 个文件')
for (const p of perFile.sort()) console.log('  ' + p)
