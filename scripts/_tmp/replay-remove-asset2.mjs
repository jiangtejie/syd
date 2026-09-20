/** 用当前真实库副本演练「删除这张」的判据（数据驱动：按素材分组） */
import Database from 'better-sqlite3-multiple-ciphers'
import { copyFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const src = join(process.env.APPDATA || '', 'wechat-cs-desktop', 'cs.db')
const tmp = join(tmpdir(), 'cs-del2-' + Date.now() + '.db')
copyFileSync(src, tmp)
for (const ext of ['-wal', '-shm']) if (existsSync(src + ext)) copyFileSync(src + ext, tmp + ext)
const db = new Database(tmp)
const imgs = (cid) => db.prepare("SELECT id, kind, rel_path, source_mark FROM growth_asset WHERE content_id = ? AND kind IN ('cover','image') AND rel_path <> '' ORDER BY id").all(cid)
const refs = (aid) => db.prepare('SELECT COUNT(*) n FROM growth_output_asset WHERE asset_id = ?').get(aid).n
const check = (kind, remaining, r) => (r > 0 ? '拦下(产出引用)' : (kind === 'cover' || kind === 'image') && remaining < 1 ? '拦下(最后一张)' : '允许')
try {
  const groups = db.prepare("SELECT content_id, COUNT(*) n FROM growth_asset WHERE kind IN ('cover','image') AND rel_path <> '' GROUP BY content_id ORDER BY n DESC LIMIT 4").all()
  for (const g of groups) {
    const rows = imgs(g.content_id)
    console.log('素材 #' + g.content_id + ' 有 ' + rows.length + ' 张图：')
    for (const r of rows.slice(0, 6)) {
      console.log('   asset ' + r.id + ' ' + r.kind + ' ' + r.source_mark + ' → ' + check(r.kind, rows.length - 1, refs(r.id)))
    }
    // 真删第一张（模拟用户点「删除这张」），再看最后一张是否会被拦
    const first = rows[0]
    db.prepare('DELETE FROM growth_asset WHERE id = ?').run(first.id)
    const left = imgs(g.content_id).length
    console.log('   删除 asset ' + first.id + ' → 剩余 ' + left + ' 张；再删一张：' + check('image', left - 1, 0))
  }
} finally { db.close() }
