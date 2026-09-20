import { readFileSync } from 'node:fs'
const p = process.argv[2]
const buf = readFileSync(p)
const s = buf.toString('latin1')
const needle = 'CREATE TABLE growth_remix_output'
const at = s.indexOf(needle)
console.log('found at', at)
if (at >= 0) console.log(s.slice(at, at + 520).replace(/[\u0000-\u001f]/g, ' '))
