/**
 * T4 spike 参数矩阵探测：针对微信 4.x 魔改 SQLCipher。
 *
 * 已知事实（公开研究）：
 * - 微信 4.x 每个库独立 salt + enc_key
 * - raw key 格式 x'<64hex_enc_key><32hex_salt>'（48B）
 * - raw key 模式 KDF 已派生，kdf_iter=2
 * - 页大小 4096
 *
 * 用法：npx electron scripts/wx-spike.mjs <dbStorage路径> <enc_key 64hex> [wxid]
 */
import { readdirSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs'
import { basename, join } from 'node:path'

let Database
try {
  Database = (await import('better-sqlite3-multiple-ciphers')).default
} catch (e) {
  console.error('加载 better-sqlite3-multiple-ciphers 失败:', e.message)
  process.exit(1)
}
console.log('[ok] 原生模块加载成功')

const [, , rootArg, encKeyHex, wxidArg] = process.argv
const wxid = wxidArg || ''
if (!rootArg || !encKeyHex || !/^[0-9a-fA-F]{64}$/.test(encKeyHex)) {
  console.error('用法: npx electron scripts/wx-spike.mjs <dbStorage路径> <enc_key 64hex> [wxid]')
  process.exit(1)
}
const encKey = encKeyHex.toLowerCase()

// ── 定位 ──
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
function findSessionDb(dir) {
  const candidates = findFiles(dir, 0, [], /^session\.db$/)
  const score = (p) => {
    const n = p.replace(/\\/g, '/').toLowerCase()
    let s = 0
    if (n.endsWith('/session/session.db')) s += 40
    if (n.includes('/db_storage/session/')) s += 20
    if (n.includes('/db_storage/')) s += 10
    return s
  }
  return candidates.sort((a, b) => score(b) - score(a) || a.localeCompare(b))
}

/** 读取文件前 16 字节（SQLCipher salt 候选） */
function readFileSalt(file) {
  try {
    const fd = openSync(file, 'r')
    try {
      const buf = Buffer.alloc(16)
      const n = readSync(fd, buf, 0, 16, 0)
      return n >= 16 ? buf.toString('hex') : null
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

const dbStorage = resolveDbStorage(rootArg)
if (!dbStorage) {
  console.error('未找到 db_storage 目录:', rootArg)
  process.exit(1)
}
console.log('db_storage:', dbStorage)
const sessionDbs = findSessionDb(dbStorage)
const msgDbs = findFiles(dbStorage, 0, [], /^(msg_|message_).*\.db$/)
const allDbs = [...new Set([...sessionDbs, ...msgDbs])]
console.log('session.db 候选:', sessionDbs.length, '| msg 库数量:', msgDbs.length)

// ── 逐库探测（微信 4.x 每库独立 enc_key+salt）──
/**
 * mode:
 *   raw32  : key = x'<encKey>'                （32B raw，仅 key）
 *   raw48f : key = x'<encKey + 文件头16B>'    （48B raw，key+salt）
 *   saltP  : 先 cipher_salt=<文件头16B> 再 key=x'<encKey>'
 *   pass   : key = '<encKey>'（口令模式，PBKDF2）
 */
function tryOpen(file, legacy, mode, kdfIter) {
  let db = null
  try {
    db = new Database(file, { readonly: true })
    db.pragma(`cipher = 'sqlcipher'`)
    db.pragma(`legacy = ${legacy}`)
    if (kdfIter) db.pragma(`kdf_iter = ${kdfIter}`)
    if (mode === 'raw32') {
      db.pragma(`key = "x'${encKey}'"`)
    } else if (mode === 'raw48f') {
      const salt = readFileSalt(file)
      if (!salt) return { ok: false, error: '无法读取文件头 salt' }
      db.pragma(`key = "x'${encKey}${salt}'"`)
    } else if (mode === 'saltP') {
      const salt = readFileSalt(file)
      if (!salt) return { ok: false, error: '无法读取文件头 salt' }
      db.pragma(`cipher_salt = "x'${salt}'"`)
      db.pragma(`key = "x'${encKey}'"`)
    } else if (mode === 'pass') {
      db.pragma(`key = '${encKey}'`)
    }
    const row = db.prepare('SELECT count(*) AS n FROM sqlite_master').get()
    return { ok: true, tables: row.n, salt: readFileSalt(file) }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  } finally {
    try { db?.close() } catch { }
  }
}

const MODES = ['raw48f', 'saltP', 'raw32', 'pass']
const LEGACIES = [4, 3]
const KDF_VALUES = [undefined, 2, 256000]

console.log('\n== 逐库矩阵探测（enc_key 与文件头 salt 组合）==')
let winner = null
for (const file of allDbs) {
  const salt = readFileSalt(file)
  console.log(`\n-- ${file} --`)
  if (salt) console.log(`   fileSalt(前16B): ${salt}`)
  for (const legacy of LEGACIES) {
    for (const mode of MODES) {
      for (const kdf of KDF_VALUES) {
        const label = `legacy=${legacy} mode=${mode} kdf=${kdf ?? 'default'}`
        const r = tryOpen(file, legacy, mode, kdf)
        if (r.ok) {
          console.log(`  [OK]  ${label}  -> sqlite_master 行数=${r.tables}`)
          winner = { file, legacy, mode, kdf }
          break
        } else {
          const brief = r.error.length > 60 ? r.error.slice(0, 60) + '...' : r.error
          console.log(`  [X]   ${label}: ${brief}`)
        }
      }
      if (winner) break
    }
    if (winner) break
  }
  if (winner) break
}

if (!winner) {
  console.error('\n全部库/组合失败：enc_key 与任何库都不匹配，或微信 4.x 魔改格式无法用标准驱动打开')
  process.exit(2)
}

// ── 打开并抽样 schema ──
console.log(`\n== 命中: ${winner.file}\n   legacy=${winner.legacy} mode=${winner.mode} kdf=${winner.kdf ?? 'default'}`)
const db = new Database(winner.file, { readonly: true })
db.pragma(`cipher = 'sqlcipher'`)
db.pragma(`legacy = ${winner.legacy}`)
if (winner.kdf) db.pragma(`kdf_iter = ${winner.kdf}`)
if (winner.mode === 'raw32') db.pragma(`key = "x'${encKey}'"`)
else if (winner.mode === 'raw48f') {
  const salt = readFileSalt(winner.file)
  db.pragma(`key = "x'${encKey}${salt}'"`)
} else if (winner.mode === 'saltP') {
  const salt = readFileSalt(winner.file)
  db.pragma(`cipher_salt = "x'${salt}'"`)
  db.pragma(`key = "x'${encKey}'"`)
} else db.pragma(`key = '${encKey}'`)

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
console.log('== 表:', tables.map((t) => t.name).join(', '))
for (const t of tables.slice(0, 5)) {
  const cols = db.prepare(`PRAGMA table_info("${t.name}")`).all().map((c) => c.name)
  console.log(`   ${t.name}: ${cols.join(', ')}`)
}
db.close()
console.log('\nspike 参数矩阵完成。')
