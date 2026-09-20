import { readFileSync, writeFileSync } from 'node:fs'
const p = process.argv[2]
const from = process.argv[3]
const to = process.argv[4]
const s = readFileSync(p, 'utf8')
if (!s.includes(from)) {
  console.error('ANCHOR_NOT_FOUND')
  process.exit(2)
}
writeFileSync(p, s.replace(from, to), 'utf8')
console.log('REPLACED ok, bytes=' + String(Buffer.byteLength(s, 'utf8')))
