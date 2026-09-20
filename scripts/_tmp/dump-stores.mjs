/** 门店档案到底写进了哪一行；任务 5 绑的是哪一行 */
import Database from 'better-sqlite3-multiple-ciphers'
import { copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const src = join(process.env.APPDATA || '', 'wechat-cs-desktop', 'cs.db')
const tmp = join(tmpdir(), 'cs-store-' + Date.now() + '.db')
copyFileSync(src, tmp)
const db = new Database(tmp, { readonly: true })
try {
  console.log('== growth_store ==')
  for (const s of db.prepare('SELECT id, name, brand_name, city, biz_type, address, enabled, profile_json FROM growth_store ORDER BY id').all()) {
    console.log('#' + s.id, s.name, '| enabled=' + s.enabled, '| profile=' + String(s.profile_json).slice(0, 400))
  }
  console.log('== 任务 5 ==')
  console.log(JSON.stringify(db.prepare('SELECT id, content_id, store_id, goal, session_id FROM growth_ai_task WHERE id = 5').get()))
  console.log('== 所有任务 ==')
  for (const t of db.prepare('SELECT id, content_id, store_id, session_id, updated_at FROM growth_ai_task ORDER BY id').all()) console.log(JSON.stringify(t))
} finally { db.close() }
