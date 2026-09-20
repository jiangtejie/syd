/** 素材 9 的拆解卡 / 视觉拆解 / 门店档案（决定"模仿生成"能不能照结构） */
import Database from 'better-sqlite3-multiple-ciphers'
import { copyFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const src = join(process.env.APPDATA || '', 'wechat-cs-desktop', 'cs.db')
const tmp = join(tmpdir(), 'cs-decomp-' + Date.now() + '.db')
copyFileSync(src, tmp)
const db = new Database(tmp, { readonly: true })
try {
  const d = db.prepare('SELECT content_id, model_ver, structure_json, visual_json, comment_topics_json FROM growth_decomp WHERE content_id = 9 ORDER BY id DESC LIMIT 1').get()
  console.log('== 拆解卡(素材 9) ==')
  if (!d) console.log('（没有拆解卡）')
  else {
    const s = JSON.parse(d.structure_json || '{}')
    console.log('model_ver:', d.model_ver)
    console.log('structure keys:', Object.keys(s).join(','))
    console.log('hook:', String(s.hook ?? '').slice(0, 120))
    console.log('structure:', String(s.structure ?? '').slice(0, 300))
    console.log('== 视觉拆解 ==')
    console.log(String(d.visual_json ?? '').slice(0, 900))
  }
  console.log('== 门店档案 ==')
  console.log(JSON.stringify(db.prepare('SELECT id, name, city, biz_type, address, profile_json FROM growth_store WHERE id = 5').get()))
  console.log('== 品牌资料包 ==')
  console.log(JSON.stringify(db.prepare('SELECT name, profile_json FROM growth_brand_profile ORDER BY id DESC LIMIT 1').get()))
} finally { db.close() }
