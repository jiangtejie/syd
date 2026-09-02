const Database = require('better-sqlite3-multiple-ciphers')
const path = require('path')
const fzstd = require('fzstd')
const dir = 'D:/wechat-cs-desktop/cache/wx-plain'

const msgDb = new Database(path.join(dir, 'message_0_91cd662a824462c8.db'), { readonly: true })
const table = 'Msg_4222d698e58b085e6cf065cbd3e1dbfc'

const imgs = msgDb.prepare(`SELECT * FROM "${table}" WHERE local_type = 3 LIMIT 1`).all()
for (const m of imgs) {
  const raw = m.message_content
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
  const out = fzstd.decompress(buf)
  const s = Buffer.from(out).toString('utf-8')
  console.log('FULL XML (len', s.length, '):')
  console.log(s)
}
