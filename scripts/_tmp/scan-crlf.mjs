import { execSync } from 'child_process'
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
const out = execSync('git diff --name-only HEAD', { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
const files = []
function walk(d) { for (const e of readdirSync(d)) { const p = join(d, e); const st = statSync(p); if (st.isDirectory()) walk(p); else files.push(p) } }
walk('src')
const bad = []
for (const f of files) {
  const buf = readFileSync(f)
  if (buf.includes(13)) bad.push([f, buf.filter ? 0 : 0, (buf.toString('utf8').match(/\r\n/g) || []).length])
}
console.log('CRLF 文件：')
for (const [f, , n] of bad) console.log('  ' + f + ' (' + n + ' 行 CRLF)')
console.log('共 ' + bad.length + ' 个')
