import { readFileSync } from 'node:fs'
const s = readFileSync(process.argv[2]).toString('latin1')
const re = /CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+) \(/g
let m
const seen = new Set()
while ((m = re.exec(s))) {
  const name = m[1]
  if (seen.has(name)) continue
  seen.add(name)
  const body = s.slice(m.index, s.indexOf(')', m.index) + 1)
  const cols = body.match(/[a-z_]+ [A-Z]+[^,)]*/g) || []
  const notNull = cols.filter((c) => /NOT NULL/i.test(c) && !/DEFAULT/i.test(c))
  console.log('### ' + name + '  NOT NULL-无默认: ' + (notNull.length ? notNull.join(' | ') : '(无)'))
}
console.log('tables in legacy db:', seen.size)
