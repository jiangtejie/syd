const Database = require('better-sqlite3-multiple-ciphers')
const crypto = require('crypto')
const path = require('path')

const dir = 'D:/wechat-cs-desktop/cache/wx-plain'

const sessionDb = new Database(path.join(dir, 'session_9f504540d9e27506.db'), { readonly: true })
const msgDb = new Database(path.join(dir, 'message_0_91cd662a824462c8.db'), { readonly: true })

// 1. session 表结构 + 找群会话
const stables = sessionDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
console.log('session tables:', stables.map((t) => t.name).join(', '))
const sessTbl = stables.find((t) => /session/i.test(t.name))?.name
const sessCols = sessionDb.prepare(`PRAGMA table_info(${sessTbl})`).all().map((c) => c.name)
console.log('session cols:', sessCols.join(', '))

const groups = sessionDb.prepare(`SELECT * FROM ${sessTbl} WHERE username LIKE '%@chatroom' LIMIT 5`).all()
for (const g of groups) {
  console.log('group session:', JSON.stringify(g).slice(0, 300))
}

// 取一个群的 username
const groupUsername = groups[0]?.username
console.log('\n=== probe group ===', groupUsername)

const hash = crypto.createHash('md5').update(groupUsername).digest('hex').toLowerCase()
const msgTable = 'msg_' + hash
console.log('expected msg table:', msgTable)

const mtables = msgDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND lower(name) LIKE 'msg_%'").all().map((t) => t.name)
console.log('msg tables count:', mtables.length)
console.log('has expected?', mtables.includes(msgTable))

if (mtables.includes(msgTable)) {
  const cols = msgDb.prepare(`PRAGMA table_info("${msgTable}")`).all().map((c) => c.name)
  console.log('msg cols:', cols.join(', '))

  // 找图片消息 local_type=3
  const imgs = msgDb.prepare(`SELECT * FROM "${msgTable}" WHERE local_type = 3 LIMIT 10`).all()
  console.log('image messages:', imgs.length)
  for (const m of imgs) {
    const contentCol = cols.find((c) => /message_content|display_content|msg_content|str_content|content/i.test(c))
    const raw = m[contentCol]
    let s = ''
    if (Buffer.isBuffer(raw)) s = raw.toString('utf-8')
    else if (raw instanceof Uint8Array) s = Buffer.from(raw).toString('utf-8')
    else s = String(raw ?? '')
    console.log('--- local_id=', m.local_id, 'type=', m.local_type, 'len=', s.length)
    console.log('    content:', s.slice(0, 600))
  }
}
