/**
 * 临时工具：读取本地 cs.db 中已保存的密钥档案（wxid/dbPath），用于解密层真实库验证。
 * 用法：npx electron scripts/inspect-keystore.mjs
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const file = join(process.env.APPDATA || '', 'wechat-cs-desktop', 'cs.db')
if (!existsSync(file)) {
  console.log('cs.db 不存在:', file)
  process.exit(0)
}
const Database = (await import('better-sqlite3-multiple-ciphers')).default
const db = new Database(file, { readonly: true })
const rows = db.prepare('SELECT wxid, db_path, source, status FROM key_store').all()
console.log('key_store:', JSON.stringify(rows, null, 1))
