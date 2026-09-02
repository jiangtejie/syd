const Database = require('better-sqlite3-multiple-ciphers')
const path = require('path')
const dir = 'D:/wechat-cs-desktop/cache/wx-plain'

const msgDb = new Database(path.join(dir, 'message_0_91cd662a824462c8.db'), { readonly: true })

const mtables = msgDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND lower(name) LIKE 'msg_%'").all().map((t) => t.name)
console.log('total msg tables:', mtables.length)
console.log(mtables.join('\n'))

// 统计每个表是否有 local_type=3 图片消息，及其 content 字段
for (const t of mtables) {
  try {
    const cols = msgDb.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name)
    const hasLocalType = cols.includes('local_type')
    if (!hasLocalType) { console.log(t, '=> no local_type col, cols=', cols.join(',')); continue }
    const imgCount = msgDb.prepare(`SELECT count(*) AS n FROM "${t}" WHERE local_type = 3`).get().n
    if (imgCount > 0) {
      console.log(t, '=> image messages:', imgCount)
    }
  } catch (e) {
    console.log(t, 'ERR', e.message)
  }
}
