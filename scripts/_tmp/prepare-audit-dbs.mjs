/** 准备两个对照库：① 老库副本跑完迁移 ② 全新空库（当前代码建表）—— 供 db-shape-audit 复核 */
import Database from 'better-sqlite3-multiple-ciphers'
import { buildSync } from 'esbuild'
import { copyFileSync, mkdtempSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const [src, root, outDir] = process.argv.slice(2)
mkdirSync(outDir, { recursive: true })
const work = mkdtempSync(join(outDir, 'bundle-'))
const bundle = resolve(work, 'schema.cjs')
buildSync({
  entryPoints: [join(root, 'src/main/db/schema.ts')],
  bundle: true, platform: 'node', format: 'cjs', outfile: bundle,
  external: ['better-sqlite3-multiple-ciphers']
})
const { migrate } = require(bundle)

const migrated = join(outDir, 'migrated.db')
copyFileSync(src, migrated)
const db1 = new Database(migrated)
migrate(db1)
db1.close()

const fresh = join(outDir, 'fresh.db')
const db2 = new Database(fresh)
migrate(db2)
db2.close()
console.log('migrated=' + migrated)
console.log('fresh=' + fresh)
