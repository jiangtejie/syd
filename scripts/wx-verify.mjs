/**
 * T4 spike：微信 4.x 魔改 SQLCipher 格式验证（最小实现，参考公开解密工具思路）。
 *
 * 格式要点（公开研究确认）：
 * - page_size=4096, reserve=80 = IV(16) + HMAC(64)
 * - 页1: salt=前16B明文, 加密区=file[16:4096-80], IV=file[4096-80:4096-64]
 * - 页N: 加密区=page[:4096-80], IV=page[4096-80:4096-64]
 * - enc_key 直接作 AES-256 key（不派生）
 * - mac_key = PBKDF2-HMAC-SHA512(enc_key, salt^0x3a, 2次, 32B)
 * - 页1 HMAC 校验 = HMAC-SHA512(mac_key, file[16:4096-80+16] + pgno(1))
 *
 * 用法：npx electron scripts/wx-verify.mjs <dbStorage路径> <enc_key 64hex> [wxid]
 */
import { readdirSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs'
import { basename, join } from 'node:path'
import { createHmac, pbkdf2Sync } from 'node:crypto'

const PAGE_SZ = 4096
const SALT_SZ = 16
const IV_SZ = 16
const HMAC_SZ = 64
const RESERVE_SZ = 80

const [, , rootArg, encKeyHex, wxidArg] = process.argv
const wxid = wxidArg || ''
if (!rootArg || !encKeyHex || !/^[0-9a-fA-F]{64}$/.test(encKeyHex)) {
  console.error('用法: npx electron scripts/wx-verify.mjs <dbStorage路径> <enc_key 64hex> [wxid]')
  process.exit(1)
}
const encKey = Buffer.from(encKeyHex.toLowerCase(), 'hex')

function listDirs(input) {
  try { return readdirSync(input) } catch { return [] }
}
function resolveDbStorage(input) {
  if (basename(input).toLowerCase() === 'db_storage' && existsSync(input)) return input
  const direct = join(input, 'db_storage')
  if (existsSync(direct)) return direct
  if (wxid) {
    const via = join(input, wxid, 'db_storage')
    if (existsSync(via)) return via
    for (const entry of listDirs(input)) {
      const p = join(input, entry)
      try { if (!statSync(p).isDirectory()) continue } catch { continue }
      if (entry.toLowerCase().startsWith(wxid.toLowerCase())) {
        const c = join(p, 'db_storage')
        if (existsSync(c)) return c
      }
    }
  }
  return null
}
function findFiles(dir, depth = 0, acc = [], pattern = null) {
  if (depth > 4) return acc
  let entries
  try { entries = readdirSync(dir) } catch { return acc }
  for (const e of entries) {
    const full = join(dir, e)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isFile()) {
      if (!pattern || pattern.test(e.toLowerCase())) acc.push(full)
    } else if (st.isDirectory()) {
      findFiles(full, depth + 1, acc, pattern)
    }
  }
  return acc
}

function readBytes(file, len, offset = 0) {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(len)
    const n = readSync(fd, buf, 0, len, offset)
    return n > 0 ? buf.subarray(0, n) : null
  } finally {
    closeSync(fd)
  }
}

/** 校验单库页1 HMAC */
function verifyDb(file) {
  const page1 = readBytes(file, PAGE_SZ, 0)
  if (!page1 || page1.length < PAGE_SZ) {
    return { ok: false, error: '文件过小或无法读取' }
  }
  const salt = page1.subarray(0, SALT_SZ)
  const macSalt = Buffer.from(salt)
  for (let i = 0; i < macSalt.length; i++) macSalt[i] ^= 0x3a
  const macKey = pbkdf2Sync(encKey, macSalt, 2, 32, 'sha512')

  const hmacData = Buffer.concat([
    page1.subarray(SALT_SZ, PAGE_SZ - RESERVE_SZ + IV_SZ)
  ])
  const storedHmac = page1.subarray(PAGE_SZ - HMAC_SZ, PAGE_SZ)
  const pgno = Buffer.alloc(4)
  pgno.writeUInt32LE(1, 0)

  const hm = createHmac('sha512', macKey)
  hm.update(hmacData)
  hm.update(pgno)
  const calc = hm.digest()
  const ok = calc.equals(storedHmac)
  return { ok, salt: salt.toString('hex'), calcHmac: calc.toString('hex').slice(0, 16), storedHmac: storedHmac.toString('hex').slice(0, 16) }
}

const dbStorage = resolveDbStorage(rootArg)
if (!dbStorage) {
  console.error('未找到 db_storage 目录:', rootArg)
  process.exit(1)
}
console.log('db_storage:', dbStorage)
const sessionDbs = findFiles(dbStorage, 0, [], /^session\.db$/)
const msgDbs = findFiles(dbStorage, 0, [], /^(msg_|message_).*\.db$/)
const contactDbs = findFiles(dbStorage, 0, [], /^contact(_new)?\.db$/)
const allDbs = [...new Set([...sessionDbs, ...msgDbs, ...contactDbs])]

console.log(`共 ${allDbs.length} 个候选库，逐库 HMAC 校验 enc_key...\n`)
let matched = 0
for (const file of allDbs) {
  const r = verifyDb(file)
  const tag = r.ok ? 'MATCH' : '  no '
  if (r.ok) matched++
  console.log(`[${tag}] ${file}`)
  if (r.ok) {
    console.log(`        salt=${r.salt}`)
  }
}
console.log(`\n匹配库数: ${matched}/${allDbs.length}`)
if (matched === 0) {
  console.log('结论: enc_key 与任何库都不匹配（key 来源版本不符，或微信版本库格式不同）')
} else {
  console.log('结论: enc_key 有效，微信 4.x 库为魔改 SQLCipher（非标准布局），标准 SQLCipher 驱动无法直开，需自研 AES 解密层')
}
