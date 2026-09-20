import { buildSync } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const root = process.argv[2]
const work = mkdtempSync(join(tmpdir(), 'dbg-'))
buildSync({
  entryPoints: [join(root, 'src/main/db/schema/customer.ts')],
  bundle: true, platform: 'node', format: 'cjs',
  outfile: resolve(work, 'c.cjs'), external: ['better-sqlite3-multiple-ciphers']
})
const { CUSTOMER_TABLES } = require(resolve(work, 'c.cjs'))
for (const ddl of CUSTOMER_TABLES) {
  const name = (ddl.match(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/) || [])[1]
  const open = ddl.indexOf('(')
  const body = ddl.slice(open + 1, ddl.lastIndexOf(')'))
  const cols = []
  for (const raw of body.split(/,(?![^(]*\))/)) {
    const line = raw.trim()
    const m = line.match(/^([a-z_][a-z0-9_]*)\s+([A-Za-z]+)/)
    if (!m || /^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)$/i.test(m[1])) continue
    cols.push(m[1])
  }
  console.log(name + ' -> ' + cols.join(','))
}
