// 调试：检查 message_0.db 原始头与解密后头字节
import { readFileSync } from 'node:fs'
import { createDecipheriv, pbkdf2Sync, createHash } from 'node:crypto'

const DB_PATH = 'C:\\Users\\Administrator\\Documents\\xwechat_files\\wxid_r9l5xuni9ng522_7e0b\\db_storage\\message\\message_0.db'
const HEX_KEY = 'f88e7baa688f4651be5d1e1a78c053af65cd36502ad94e6db1d0f53d23a591d3'

const raw = readFileSync(DB_PATH)
console.log('文件大小:', raw.length)
console.log('原始头 32B hex:', raw.subarray(0, 32).toString('hex'))
console.log('原始头 16B ascii:', JSON.stringify(raw.subarray(0, 16).toString('latin1')))

const PAGE = 4096
const RESERVE = 80
const ENC_LEN = PAGE - RESERVE
const salt = raw.subarray(0, 16)
const encKey = Buffer.from(HEX_KEY, 'hex')

// 尝试多种派生参数
const variants = [
  { name: 'sha512-256000', hash: 'sha512', iter: 256000 },
  { name: 'sha512-64000', hash: 'sha512', iter: 64000 },
  { name: 'sha256-256000', hash: 'sha256', iter: 256000 },
  { name: 'sha1-64000', hash: 'sha1', iter: 64000 },
]

for (const v of variants) {
  const aesKey = pbkdf2Sync(encKey, salt, v.iter, 32, v.hash)
  const iv = raw.subarray(ENC_LEN, ENC_LEN + 16)
  const decipher = createDecipheriv('aes-256-cbc', aesKey, iv)
  decipher.setAutoPadding(false)
  const plain = Buffer.concat([decipher.update(raw.subarray(16, ENC_LEN)), decipher.final()])
  // 页1解密后，偏移 16-17 应为页大小 0x1000，偏移 18/19 应为 01 01
  console.log(`\n[${v.name}] 页1解密后前 48B hex:`, plain.subarray(0, 48).toString('hex'))
  const pageSize = plain.readUInt16BE(0)
  console.log(`  解释: 页大小字段=${pageSize === 1 ? 65536 : pageSize}, fileFormatWrite=${plain[18 - 16]}, read=${plain[19 - 16]}, reserve=${plain[20 - 16]}`)
}

// 检查 -wal 文件
import { existsSync, statSync } from 'node:fs'
console.log('\n-wal 存在:', existsSync(DB_PATH + '-wal'), existsSync(DB_PATH + '-wal') ? statSync(DB_PATH + '-wal').size : '')
console.log('-shm 存在:', existsSync(DB_PATH + '-shm'))
