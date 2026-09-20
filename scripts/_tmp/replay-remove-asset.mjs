/** 在真实库副本上演练「删除这张」：素材 #9 有两张图 → 删一张允许、删完最后一张拦下 */
import Database from 'better-sqlite3-multiple-ciphers'
import { copyFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const src = join(process.env.APPDATA || '', 'wechat-cs-desktop', 'cs.db')
const tmp = join(tmpdir(), 'cs-del-' + Date.now() + '.db')
copyFileSync(src, tmp)
for (const ext of ['-wal', '-shm']) if (existsSync(src + ext)) copyFileSync(src + ext, tmp + ext)
const db = new Database(tmp)
const count = (cid) => db.prepare("SELECT COUNT(*) n FROM growth_asset WHERE content_id = ? AND kind IN ('cover','image') AND rel_path <> ''").get(cid).n
const refs = (aid) => db.prepare('SELECT COUNT(*) n FROM growth_output_asset WHERE asset_id = ?').get(aid).n
try {
  const cid = 9
  const rows = db.prepare("SELECT id, kind, rel_path FROM growth_asset WHERE content_id = ? ORDER BY id").all(cid)
  console.log('素材 9 的图:', JSON.stringify(rows))
  console.log('可展示图数 =', count(cid))
  for (const r of rows) console.log('  asset', r.id, '产出引用 =', refs(r.id), '→ 删完还剩', count(cid) - 1, count(cid) - 1 < 1 ? '（拦下）' : '（允许）')
  // 真的删一张（模拟用户操作：删掉那张误合成图）
  const victim = rows[1]
  db.prepare('DELETE FROM growth_asset WHERE id = ?').run(victim.id)
  console.log('删除 asset', victim.id, '后剩余图数 =', count(cid))
  // 再删最后一张：规则会拦（这里只验证判据，不执行）
  console.log('再删最后一张 →', count(cid) - 1 < 1 ? '拦下（至少要保留一张图）' : '允许')
} finally { db.close() }
