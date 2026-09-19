/**
 * 数据库形状体检：把「某个库的实际表结构」与「当前代码期望的表结构」逐列比对，
 * 专门抓一类**静默故障**——
 *
 *   代码演进时删掉的往往只是建表 DDL 里那一行，而 CREATE TABLE IF NOT EXISTS 从不改既有表：
 *   老库里那一列还在（常常还是 NOT NULL 无默认值），于是当前代码的 INSERT 不带它就必然撞
 *   NOT NULL constraint failed。用户侧的观感是「功能偶尔坏掉 / AI 在胡说」，
 *   而 AI 那边只会收到一句「工具执行失败:NOT NULL constraint failed: 表.列」——
 *   实测就是这句话被模型讲成了「后端任务没落库，请用户手工建产出块」（营销生图，任务 5）。
 *
 * 用法：
 *   node scripts/db-shape-audit.mjs <cs.db 路径> [数据库密钥(64 位十六进制)]
 *   密钥：设置 → 偏好与数据 → 数据库密钥（也可用 cs.db 副本，副本不改动原库）
 *
 * 期望的形状直接取自 src/main/db/schema/（四组表 DDL + 补列清单），不另抄一份，
 * 所以它永远对着「当前代码」判断，而不是对着某个历史快照。
 */
import Database from 'better-sqlite3-multiple-ciphers'
import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dbPath = process.argv[2]
const key = process.argv[3]
if (!dbPath) {
  console.error('用法: node scripts/db-shape-audit.mjs <cs.db> [数据库密钥]')
  process.exit(1)
}

const work = mkdtempSync(join(tmpdir(), 'db-shape-audit-'))
// 四组表 DDL 分散在 schema/{base,growth,ai,customer}.ts（schema.ts 只 import 不 re-export），
// 连同补列清单一起打成 CJS 再读 —— 这样期望形状永远等于当前代码，而不是我抄的一份快照。
buildSync({
  entryPoints: [
    join(root, 'src/main/db/schema/base.ts'),
    join(root, 'src/main/db/schema/growth.ts'),
    join(root, 'src/main/db/schema/ai.ts'),
    join(root, 'src/main/db/schema/customer.ts'),
    join(root, 'src/main/db/schema/columns.ts')
  ],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outdir: join(work, 'schema'),
  outExtension: { '.js': '.cjs' },
  external: ['better-sqlite3-multiple-ciphers']
})
const load = (n) => require(join(work, 'schema', n + '.cjs'))
const baseSchema = load('base')
const growthSchema = load('growth')
const aiSchema = load('ai')
const customerSchema = load('customer')
const { COLUMN_MIGRATIONS } = load('columns')

/** 从 CREATE TABLE 文本里取列名 + 是否 NOT NULL 无默认 */
function colsOf(ddl) {
  const out = new Map()
  const open = ddl.indexOf('(')
  const body = ddl.slice(open + 1, ddl.lastIndexOf(')'))
  for (const raw of body.split(/,(?![^(]*\))/)) {
    // DDL 里的--注释要先去干净：否则「注释行 + 列定义」会黏成一段，
    // 正则匹配不上（实测漏掉了 customer_profile.username）
    const line = raw.replace(/--[^\n]*/g, ' ').trim()
    const m = line.match(/^([a-z_][a-z0-9_]*)\s+([A-Za-z]+)/)
    if (!m || /^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)$/i.test(m[1])) continue
    out.set(m[1], /NOT NULL/i.test(line) && !/DEFAULT/i.test(line))
  }
  return out
}

const expected = new Map()
for (const ddl of [
  ...baseSchema.CORE_TABLES,
  ...growthSchema.GROWTH_TABLES,
  ...aiSchema.AI_TABLES,
  ...customerSchema.CUSTOMER_TABLES
]) {
  const m = ddl.match(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/)
  if (m) expected.set(m[1], colsOf(ddl))
}
for (const c of COLUMN_MIGRATIONS) {
  if (!expected.has(c.table)) expected.set(c.table, new Map())
  expected.get(c.table).set(c.column, /NOT NULL/i.test(c.ddl) && !/DEFAULT/i.test(c.ddl))
}

const db = new Database(resolve(dbPath), { readonly: true, fileMustExist: true })
if (key) db.pragma("key='" + key + "'")
db.prepare('SELECT count(*) FROM sqlite_master').get() // 密钥错了会在这里抛（file is not a database）

let killer = 0
let noisy = 0
let missing = 0
try {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name)
  for (const t of tables) {
    const exp = expected.get(t)
    if (!exp) continue // 已下线功能的遗留表：不影响使用，略过
    const actual = db.prepare('PRAGMA table_info(' + t + ')').all()
    const names = new Set(actual.map((c) => c.name))
    for (const c of actual) {
      if (exp.has(c.name)) continue
      if (c.notnull === 1 && c.dflt_value === null && c.pk === 0) {
        killer++
        console.log('★ 写入必失败  ' + t + '.' + c.name + ' —— 老库 NOT NULL 且无默认值，当前代码不写它')
      } else {
        noisy++
        console.log('  无害多列    ' + t + '.' + c.name)
      }
    }
    for (const name of exp.keys()) {
      if (!names.has(name)) {
        missing++
        console.log('  缺列(启动自动补)  ' + t + '.' + name)
      }
    }
  }
} finally {
  db.close()
  try {
    rmSync(work, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

console.log('')
console.log('结论: 会挡住写入的列 ' + String(killer) + ' 个 · 无害多列 ' + String(noisy) + ' 个 · 缺列 ' + String(missing) + ' 个')
process.exit(killer > 0 ? 1 : 0)
