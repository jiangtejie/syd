const Database = require('better-sqlite3-multiple-ciphers')
const path = require('path')
const fzstd = require('fzstd')
const dir = 'D:/wechat-cs-desktop/cache/wx-plain'

const msgDb = new Database(path.join(dir, 'message_0_91cd662a824462c8.db'), { readonly: true })
const table = 'Msg_4222d698e58b085e6cf065cbd3e1dbfc'

const imgs = msgDb.prepare(`SELECT * FROM "${table}" WHERE local_type = 3 LIMIT 3`).all()
for (const m of imgs) {
  console.log('\n===== local_id=', m.local_id, '=====')
  for (const key of ['message_content', 'compress_content', 'packed_info_data']) {
    const raw = m[key]
    if (raw === null || raw === undefined) { console.log(key, '=> null'); continue }
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    console.log(`${key}: len=${buf.length} hex_head=${buf.subarray(0, 24).toString('hex')}`)

    // 尝试 zstd 解压 compress_content
    if (key === 'compress_content') {
      try {
        const out = fzstd.decompress(buf)
        console.log('  compress_content zstd-decompressed:', out.toString('utf-8').slice(0, 800))
      } catch (e) {
        console.log('  compress_content zstd fail:', e.message)
      }
    }
  }
}
