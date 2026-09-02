const Database = require('better-sqlite3-multiple-ciphers')
const path = require('path')
const dir = 'D:/wechat-cs-desktop/cache/wx-plain'

const msgDb = new Database(path.join(dir, 'message_0_91cd662a824462c8.db'), { readonly: true })

const table = 'Msg_4222d698e58b085e6cf065cbd3e1dbfc'
const cols = msgDb.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name)
console.log('cols:', cols.join(', '))

const imgs = msgDb.prepare(`SELECT * FROM "${table}" WHERE local_type = 3 LIMIT 10`).all()
console.log('image count:', imgs.length)
for (const m of imgs) {
  const contentCol = cols.find((c) => /message_content|display_content|msg_content|str_content|content/i.test(c))
  const raw = m[contentCol]
  let s = ''
  if (Buffer.isBuffer(raw)) s = raw.toString('utf-8')
  else if (raw instanceof Uint8Array) s = Buffer.from(raw).toString('utf-8')
  else s = String(raw ?? '')
  console.log('\n--- local_id=', m.local_id, 'contentCol=', contentCol, 'len=', s.length)
  console.log(s.slice(0, 800))
}
