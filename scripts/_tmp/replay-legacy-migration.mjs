/**
 * 在**真实老库的副本**上验证迁移 7（备份库是明文的，可安全演练；绝不碰线上加密库）。
 * 这里用的列清单与线上 createOutput / addOutputAsset 逐字一致。
 */
import Database from 'better-sqlite3-multiple-ciphers'
import { buildSync } from 'esbuild'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const src = process.argv[2]
const root = process.argv[3]
const work = mkdtempSync(join(tmpdir(), 'legacy-replay-'))
const file = join(work, 'copy.db')
copyFileSync(src, file)

const bundle = join(work, 'schema.cjs')
buildSync({
  entryPoints: [join(root, 'src/main/db/schema.ts')],
  bundle: true, platform: 'node', format: 'cjs', outfile: bundle,
  external: ['better-sqlite3-multiple-ciphers']
})
const { migrate } = require(bundle)

const db = new Database(file)
try {
  const before = db.prepare('PRAGMA table_info(growth_remix_output)').all()
  const beforeRows = db.prepare('SELECT COUNT(*) c FROM growth_remix_output').get().c
  const assetsBefore = db.prepare('SELECT COUNT(*) c FROM growth_output_asset').get().c
  const sampleBefore = db.prepare('SELECT id, title, status FROM growth_remix_output ORDER BY id DESC LIMIT 3').all()
  console.log('迁移前 user_version =', db.pragma('user_version', { simple: true }))
  console.log('迁移前列:', before.map((c) => c.name + (c.notnull ? '!' : '')).join(', '))
  console.log('迁移前行数:', beforeRows, '| 挂图行数:', assetsBefore)
  console.log('样例:', JSON.stringify(sampleBefore))

  const res = migrate(db)
  console.log('applied =', JSON.stringify(res.applied), '| from', res.from, '→ to', res.to)

  const after = db.prepare('PRAGMA table_info(growth_remix_output)').all()
  const job = after.find((c) => c.name === 'job_id')
  const up = db.prepare('PRAGMA table_info(growth_output_asset)').all().find((c) => c.name === 'updated_at')
  const afterRows = db.prepare('SELECT COUNT(*) c FROM growth_remix_output').get().c
  const sampleAfter = db.prepare('SELECT id, title, status, job_id FROM growth_remix_output ORDER BY id DESC LIMIT 3').all()
  console.log('job_id 列:', job ? '仍在, notnull=' + String(job.notnull) : '已不存在', '| updated_at notnull=', String(up?.notnull))
  console.log('迁移后行数:', afterRows, '（应与迁移前一致）')
  console.log('样例:', JSON.stringify(sampleAfter))
  console.log('老索引还在吗:', !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_growth_remix_out_job'").get())

  // 线上失败的正是这两条写入：逐字复刻 createOutput / addOutputAsset 的列清单
  const ins = db.prepare(
    'INSERT INTO growth_remix_output (variant, title, copy_text, content_id, task_id, compliance_json, meta_json, status, created_at)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
  const r1 = ins.run('chat:title', '新候选标题', '', 1, 9, '[]', '{}', 'candidate', Date.now())
  console.log('★ 产出 INSERT 成功, 新 id =', Number(r1.lastInsertRowid))
  const r2 = db
    .prepare('INSERT INTO growth_output_asset (output_id, asset_id, role, source, prompt, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(Number(r1.lastInsertRowid), null, 'cover', 'gen', '俯拍锅底', '', Date.now())
  console.log('★ 挂图 INSERT 成功, 新 id =', Number(r2.lastInsertRowid))

  // 二次迁移必须无副作用
  const res2 = migrate(db)
  console.log('二次 migrate applied =', JSON.stringify(res2.applied), '行数:', db.prepare('SELECT COUNT(*) c FROM growth_remix_output').get().c)
} finally {
  db.close()
  try { rmSync(work, { recursive: true, force: true }) } catch { /* ignore */ }
}
