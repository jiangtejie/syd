import { execSync } from 'child_process'
import { writeFileSync } from 'fs'
const file = 'src/renderer/src/components/workbench/GroupIssuesPanel.tsx'
const diff = execSync('git diff -U3 -- "' + file + '"', { encoding: 'utf8' })
const lines = diff.split('\n')
const header = []
let i = 0
while (i < lines.length && !lines[i].startsWith('@@')) { header.push(lines[i]); i++ }
const hunks = []
let cur = null
for (; i < lines.length; i++) {
  if (lines[i].startsWith('@@')) {
    if (cur) hunks.push(cur)
    cur = [lines[i]]
  } else if (cur) cur.push(lines[i])
}
if (cur) hunks.push(cur)
console.log('共 ' + hunks.length + ' 个 hunk')
const mine = []
for (const h of hunks) {
  const body = h.join('\n')
  const isMine = body.includes('covMsgs')
  console.log('  ' + h[0] + ' → ' + (isMine ? '我的' : '并行会话的'))
  if (isMine) mine.push(body)
}
if (mine.length === 0) { console.log('没找到我的 hunk，放弃'); process.exit(1) }
writeFileSync('scripts/_tmp/mine.patch', header.join('\n') + '\n' + mine.join('\n') + '\n')
console.log('已写出 scripts/_tmp/mine.patch（' + mine.length + ' 个 hunk）')
