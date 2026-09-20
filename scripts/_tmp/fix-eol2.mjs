import { readFileSync, writeFileSync } from 'fs'
for (const f of ['scripts/lark-sync-selftest.mjs', 'scripts/wx-crypto-selftest.mjs']) {
  const src = readFileSync(f, 'utf8')
  const n = (src.match(/\r\n/g) || []).length
  if (n > 0) { writeFileSync(f, src.split('\r\n').join('\n')); console.log(f + ' CRLF→LF (' + n + ')') }
}
