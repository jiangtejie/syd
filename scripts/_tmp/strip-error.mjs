import { readFileSync, writeFileSync } from 'fs'
const f = 'src/renderer/src/pages/growth/tables.css'
let t = readFileSync(f, 'utf8')
let n = 0
for (const sel of ['.gth-error {', '.gth-error .msg {']) {
  for (let k = 0; k < 4; k++) {
    const i = t.indexOf(sel)
    if (i < 0) break
    const before = t.lastIndexOf('/*', i)
    const s = before >= 0 && t.slice(before, i).indexOf('*/') > 0 && i - before < 400 ? before : i
    const end = t.indexOf('}', i)
    t = t.slice(0, s) + t.slice(end + 1)
    n++
  }
}
writeFileSync(f, t)
console.log('删除 ' + n + ' 条 .gth-error 规则')
