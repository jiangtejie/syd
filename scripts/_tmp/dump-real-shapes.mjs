/** 用 sqlite_master（权威定义）而不是字节扫描，核对老库里两张产出表的真实形状 */
import Database from 'better-sqlite3-multiple-ciphers'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const work = mkdtempSync(join(tmpdir(), 'shapes-'))
const file = join(work, 'copy.db')
copyFileSync(process.argv[2], file)
const db = new Database(file, { readonly: true })
try {
  for (const t of ['growth_remix_output', 'growth_output_asset', 'growth_ai_task', 'growth_asset', 'growth_content', 'chat_message']) {
    const row = db.prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?').get('table', t)
    const cols = db.prepare('PRAGMA table_info(' + t + ')').all()
    console.log('### ' + t)
    console.log('  列: ' + cols.map((c) => c.name + (c.notnull ? '!' : '') + (c.dflt_value ? '=' + c.dflt_value : '')).join(', '))
    console.log('  DDL: ' + String(row?.sql ?? '(无)').replace(/\s+/g, ' ').slice(0, 300))
  }
  console.log('indexes on growth_remix_output:', JSON.stringify(db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='growth_remix_output'").all()))
} finally {
  db.close()
  try { rmSync(work, { recursive: true, force: true }) } catch { /* ignore */ }
}
