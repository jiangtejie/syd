#!/usr/bin/env node
/**
 * 微信库解密的自检（纯 Node + 离线，不需要真实微信数据）：
 *   node --experimental-strip-types scripts/wx-crypto-selftest.mjs
 *
 * 覆盖两件以前没有回归保护的事：
 * 1. 页解密/密钥校验：自己按 SQLCipher 布局**造**一个加密库（页 1 带 salt、HMAC-SHA512），
 *    断言「正确密钥通过、错误密钥被拒、篡改一字节被拒、解密结果与原文一致」；
 * 2. WAL 语义：自己按 SQLite WAL 布局造帧（头部/帧校验和、salt、nTruncate），断言
 *    「校验和错→停在该帧、跨周期→停、只应用到最后一个 commit、按 nTruncate 截断」。
 *
 * 说明：这里验证的是我们实现与 SQLite/SQLCipher 公开语义的一致性（内部往返 + 校验和链路），
 * 不是逐字节复刻腾讯魔改库（那部分由真实库在应用内验证）。
 */
import { createCipheriv, createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'

// crypto/wal.ts 用无扩展名相对导入（打包器解析），node 的 type-stripping 吃不了 → 先用 esbuild 打成 CJS
const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundleDir = mkdtempSync(join(tmpdir(), 'dsh-crypto-bundle-'))
const walBundle = join(bundleDir, 'wal.cjs')
const sqlcipherBundle = join(bundleDir, 'sqlcipher.cjs')
buildSync({
  entryPoints: [join(root, 'src/main/services/wechat/crypto/wal.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: walBundle
})
buildSync({
  entryPoints: [join(root, 'src/main/services/wechat/crypto/sqlcipher.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: sqlcipherBundle
})
const { applyWalToPlainFile, parseWalFrames } = require(walBundle)
const {
  decryptPage,
  deriveEncryptionKey,
  deriveFileMacKey,
  deriveMacKey,
  ENC_SIZE,
  KDF_ITERATIONS,
  PAGE_SIZE,
  SALT_SIZE,
  SQLITE_HEADER,
  verifyPage,
  verifyPage1,
  verifyPage1Raw
} = require(sqlcipherBundle)

let failed = 0
const log = (ok, name, detail) => {
  if (!ok) failed++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`)
}

const PASSWORD = Buffer.from('a'.repeat(64), 'hex')

/** 按 SQLCipher 布局加密一页：页 1 = [salt][cipher][iv][hmac]，页 N = [cipher][iv][hmac] */
function encryptPage(plainPage, encKey, macKey, pageNumber) {
  const iv = randomBytes(16)
  const source = pageNumber === 1 ? plainPage.subarray(SALT_SIZE, ENC_SIZE) : plainPage.subarray(0, ENC_SIZE)
  const cipher = createCipheriv('aes-256-cbc', encKey, iv)
  cipher.setAutoPadding(false)
  const body = Buffer.concat([cipher.update(source), cipher.final()])
  const page = Buffer.alloc(PAGE_SIZE)
  if (pageNumber === 1) {
    // 页 1 的前 16 字节是 salt（由调用方写入），这里只填密文
    body.copy(page, SALT_SIZE)
  } else {
    body.copy(page, 0)
  }
  iv.copy(page, ENC_SIZE)
  const hmac = createHmac('sha512', macKey)
  // 与真实库一致：HMAC 覆盖「加密区 + IV」，页 1 跳过 salt（[16,4032)），其余从 0 起（[0,4032)）
  hmac.update(page.subarray(pageNumber === 1 ? SALT_SIZE : 0, PAGE_SIZE - 64))
  const pageNo = Buffer.alloc(4)
  pageNo.writeUInt32LE(pageNumber, 0)
  hmac.update(pageNo)
  hmac.digest().copy(page, PAGE_SIZE - 64)
  return page
}

/** 造一个 n 页的加密库 + 对应的明文页数组 */
function makeEncryptedDb(pages) {
  const salt = randomBytes(SALT_SIZE)
  const encKey = pbkdf2Sync(PASSWORD, salt, KDF_ITERATIONS, 32, 'sha512')
  const macSalt = Buffer.from(salt.map((b) => b ^ 0x3a))
  const macKey = pbkdf2Sync(encKey, macSalt, 2, 32, 'sha512')
  // 注意：只有加密区 [0,4016)（页 1 为 [16,4016)）是数据，尾部 80B 保留区放 IV/HMAC，
  // 解密产物里该区域恒为 0 —— 所以测试页只在加密区填内容，避免拿保留区做逐字节比较
  const plainPages = pages.map((fill, i) => {
    const p = Buffer.alloc(PAGE_SIZE)
    if (i === 0) {
      SQLITE_HEADER.copy(p, 0)
      p.writeUInt16BE(PAGE_SIZE, 16)
      p.fill(fill, 20, ENC_SIZE)
    } else {
      p.fill(fill, 0, ENC_SIZE)
    }
    return p
  })
  const filePages = plainPages.map((p, i) => encryptPage(p, encKey, macKey, i + 1))
  filePages[0].subarray(0, SALT_SIZE).set(salt)
  return { file: Buffer.concat(filePages), plainPages, encKey, macKey, salt }
}

const work = mkdtempSync(join(tmpdir(), 'dsh-crypto-'))
try {
  console.log('\n[1] 页解密与密钥校验')
  const db = makeEncryptedDb([0x11, 0x22, 0x33])
  const firstPage = db.file.subarray(0, PAGE_SIZE)
  log(verifyPage1(firstPage, PASSWORD), '正确密钥通过页 1 HMAC 校验')
  const wrong = Buffer.from('b'.repeat(64), 'hex')
  log(!verifyPage1(firstPage, wrong), '错误密钥被拒')
  const tampered = Buffer.from(firstPage)
  tampered[SALT_SIZE + 3] ^= 0x01
  log(!verifyPage1(tampered, PASSWORD), '篡改一个字节后校验失败')
  let roundTrip = true
  for (let i = 0; i < db.plainPages.length; i += 1) {
    const enc = db.file.subarray(i * PAGE_SIZE, (i + 1) * PAGE_SIZE)
    const plain = decryptPage(enc, db.encKey, i + 1)
    if (!plain.equals(db.plainPages[i])) roundTrip = false
  }
  log(roundTrip, '三页解密结果与原文逐字节一致（含页 1 补回 SQLite 头）')

  // 逐页 HMAC：解密期的「撕裂页」检测靠它（AES-CBC 无 padding，坏页不会报错，只会安静变成垃圾）
  const fileMacKey = deriveFileMacKey(PASSWORD, db.salt)
  let allPagesOk = true
  for (let i = 0; i < db.plainPages.length; i += 1) {
    const enc = Buffer.from(db.file.subarray(i * PAGE_SIZE, (i + 1) * PAGE_SIZE))
    if (!verifyPage(enc, fileMacKey, i + 1)) allPagesOk = false
  }
  log(allPagesOk, '三页逐页 HMAC 全部通过（含非首页：覆盖加密区 + IV）')

  const torn = Buffer.from(db.file.subarray(2 * PAGE_SIZE, 3 * PAGE_SIZE))
  torn[7] ^= 0x40 // 模拟「读到半旧半新的一页」
  log(!verifyPage(torn, fileMacKey, 3), '撕裂页被逐页校验抓出（第 3 页）')
  const goodPage3 = Buffer.from(db.file.subarray(2 * PAGE_SIZE, 3 * PAGE_SIZE))
  log(
    !verifyPage(goodPage3, fileMacKey, 2),
    '页号参与 HMAC：把第 3 页当第 2 页校验必须失败'
  )
  const page1Plain = decryptPage(db.file.subarray(0, PAGE_SIZE), db.encKey, 1)
  log(page1Plain.subarray(0, 16).equals(SQLITE_HEADER), '页 1 解密后带标准 SQLite 头')
  log(
    page1Plain.subarray(ENC_SIZE).every((b) => b === 0),
    '尾部保留区（IV/HMAC）在明文里归零'
  )

  // 密钥层级：账号口令（KDF 之前）vs 库派生密钥（KDF 之后）。
  // 设置页要的是口令，但 4.1.11+ 的内存扫描/Config.Cipher 给的是每个库已派生好的 AES key，
  // 两者都是 64 位十六进制 —— 必须能识别出后者，才能报「你粘的是派生密钥」而不是「密钥不正确」。
  const rawKey = Buffer.from('c'.repeat(64), 'hex')
  const rawSalt = randomBytes(SALT_SIZE)
  const rawMacKey = pbkdf2Sync(rawKey, Buffer.from(rawSalt.map((b) => b ^ 0x3a)), 2, 32, 'sha512')
  const rawPlain = Buffer.alloc(PAGE_SIZE)
  SQLITE_HEADER.copy(rawPlain, 0)
  rawPlain.writeUInt16BE(PAGE_SIZE, 16)
  rawPlain.fill(0x55, 20, ENC_SIZE)
  const rawPage1 = encryptPage(rawPlain, rawKey, rawMacKey, 1)
  rawPage1.subarray(0, SALT_SIZE).set(rawSalt)

  log(verifyPage1Raw(rawPage1, rawKey), '库派生密钥按「跳过 KDF」语义通过页 1 校验')
  log(!verifyPage1(rawPage1, rawKey), '同一把派生密钥按口令语义校验失败（层级不可混用）')
  log(
    verifyPage1(firstPage, PASSWORD) && !verifyPage1Raw(firstPage, PASSWORD),
    '账号口令按派生密钥语义校验失败：两种层级可被区分，提示才可信'
  )

  console.log('\n[2] WAL：正常提交 + 截断语义')
  const walPath = join(work, 'a.db-wal')
  const plainPath = join(work, 'a.db')
  writeFileSync(plainPath, Buffer.concat(db.plainPages))

  /** 造 WAL：frames = [{pgno, nTruncate, plainPage}]；magic 偶数 = 校验和按小端读字 */
  function makeWal(frames, salt) {
    const nativeCksum = true
    const header = Buffer.alloc(32)
    header.writeUInt32BE(0x377f0682, 0)
    header.writeUInt32BE(3007000, 4)
    header.writeUInt32BE(PAGE_SIZE, 8)
    header.writeUInt32BE(1, 12)
    salt.subarray(0, 8).copy(header, 16)
    salt.subarray(8, 16).copy(header, 24 - 8)
    const ck = (data, init) => {
      let s1 = init[0]
      let s2 = init[1]
      for (let i = 0; i + 8 <= data.length; i += 8) {
        const a = nativeCksum ? data.readUInt32LE(i) : data.readUInt32BE(i)
        const b = nativeCksum ? data.readUInt32LE(i + 4) : data.readUInt32BE(i + 4)
        s1 = (s1 + a + s2) >>> 0
        s2 = (s2 + b + s1) >>> 0
      }
      return [s1, s2]
    }
    let sum = ck(header.subarray(0, 24), [0, 0])
    header.writeUInt32BE(sum[0], 24)
    header.writeUInt32BE(sum[1], 28)
    const parts = [header]
    frames.forEach((f, idx) => {
      const fh = Buffer.alloc(24)
      fh.writeUInt32BE(f.pgno, 0)
      fh.writeUInt32BE(f.nTruncate ?? 0, 4)
      salt.subarray(0, 8).copy(fh, 8)
      salt.subarray(8, 16).copy(fh, 16 - 8)
      const afterH = ck(fh.subarray(0, 8), sum)
      const encPage = encryptPage(f.plainPage, db.encKey, db.macKey, f.pgno)
      const afterD = ck(encPage, afterH)
      fh.writeUInt32BE(afterD[0], 16)
      fh.writeUInt32BE(afterD[1], 20)
      sum = afterD
      parts.push(fh, encPage)
      void idx
    })
    return Buffer.concat(parts)
  }

  const page2New = Buffer.alloc(PAGE_SIZE)
  page2New.fill(0xab, 0, ENC_SIZE)
  const page3Commit = Buffer.alloc(PAGE_SIZE)
  page3Commit.fill(0xcd, 0, ENC_SIZE)
  writeFileSync(walPath, makeWal([{ pgno: 2, nTruncate: 0, plainPage: page2New }, { pgno: 3, nTruncate: 4, plainPage: page3Commit }], randomBytes(16)))
  const parsed = parseWalFrames(walPath)
  log(parsed.ok, '解析通过（头部与帧校验和都对）', parsed.ok ? '' : parsed.error)
  log(parsed.ok && parsed.parsed.frames.length === 2, '读到 2 帧', parsed.ok ? String(parsed.parsed.frames.length) : '')
  log(parsed.ok && parsed.parsed.lastCommit === 2, '最后一个 commit 在第 2 帧', parsed.ok ? String(parsed.parsed.lastCommit) : '')
  log(parsed.ok && parsed.parsed.finalPages === 4, 'nTruncate=4 被识别', parsed.ok ? String(parsed.parsed.finalPages) : '')
  if (parsed.ok) {
    const applied = applyWalToPlainFile(walPath, plainPath, db.encKey, parsed.parsed)
    const merged = readFileSync(plainPath)
    log(applied.appliedFrames === 2, '应用了 2 帧', String(applied.appliedFrames))
    log(merged.length === 4 * PAGE_SIZE, '库按 nTruncate 截断为 4 页', String(merged.length / PAGE_SIZE))
    log(
      merged.subarray(PAGE_SIZE, 2 * PAGE_SIZE).equals(page2New) &&
        merged.subarray(2 * PAGE_SIZE, 3 * PAGE_SIZE).equals(page3Commit),
      'WAL 里的新内容已写回明文库'
    )
  }

  console.log('\n[2.1] 真实微信场景：头部 salt = 首帧 salt + 1 → 当前日志为空，不合并')
  const staleRun = makeWal([{ pgno: 2, nTruncate: 2, plainPage: page2New }], randomBytes(16))
  staleRun.writeUInt32BE(staleRun.readUInt32BE(16) + 1, 16) // 模拟 walRestartHdr：salt1+1（头部变新）
  const staleSum = (() => {
    const hd = Buffer.from(staleRun.subarray(0, 24))
    let s1 = 0
    let s2 = 0
    for (let i = 0; i + 8 <= hd.length; i += 8) {
      s1 = (s1 + hd.readUInt32LE(i) + s2) >>> 0
      s2 = (s2 + hd.readUInt32LE(i + 4) + s1) >>> 0
    }
    return [s1, s2]
  })()
  staleRun.writeUInt32BE(staleSum[0], 24)
  staleRun.writeUInt32BE(staleSum[1], 28)
  const stalePath = join(work, 'stale.db-wal')
  writeFileSync(stalePath, staleRun)
  const stalePlain = join(work, 'stale.db')
  writeFileSync(stalePlain, Buffer.concat(db.plainPages))
  const pStale = parseWalFrames(stalePath)
  log(
    pStale.ok && pStale.parsed.current === false,
    '判定为「当前日志为空」',
    pStale.ok ? String(pStale.parsed.reason) : pStale.error
  )
  log(pStale.ok && pStale.parsed.frames.length === 0, '不采信残留世代的帧（避免把旧内容盖回新库）')
  if (pStale.ok) {
    const appliedStale = applyWalToPlainFile(stalePath, stalePlain, db.encKey, pStale.parsed)
    log(appliedStale.appliedFrames === 0, '实际写入 0 帧')
    log(
      readFileSync(stalePlain).equals(Buffer.concat(db.plainPages)),
      '明文库内容未被改动（微信上的常态：主库已是最新）'
    )
  }

  console.log('\n[3] WAL：坏帧与跨周期必须停下')
  const broken = makeWal([{ pgno: 2, nTruncate: 2, plainPage: page2New }], randomBytes(16))
  broken[32 + 24 + 100] ^= 0xff // 破坏第一帧的页数据 → 校验和不匹配
  const brokenPath = join(work, 'b.db-wal')
  writeFileSync(brokenPath, broken)
  const p2 = parseWalFrames(brokenPath)
  log(p2.ok && p2.parsed.frames.length === 0, '坏帧被丢弃（不采信）', p2.ok ? String(p2.parsed.frames.length) : p2.error)
  log(p2.ok && p2.parsed.lastCommit === 0, '没有可用提交帧')

  const crossSalt = makeWal([{ pgno: 2, nTruncate: 2, plainPage: page2New }], randomBytes(16))
  const second = makeWal([{ pgno: 3, nTruncate: 3, plainPage: page3Commit }], randomBytes(16)).subarray(32)
  writeFileSync(join(work, 'c.db-wal'), Buffer.concat([crossSalt, second]))
  const p3 = parseWalFrames(join(work, 'c.db-wal'))
  log(p3.ok && p3.parsed.frames.length === 1, 'salt 变化即停（不会把上一周期残留当有效帧）', p3.ok ? String(p3.parsed.frames.length) : p3.error)

  console.log('\n[4] WAL：格式异常一律降级，不抛错')
  writeFileSync(join(work, 'd.db-wal'), Buffer.alloc(10))
  const p4 = parseWalFrames(join(work, 'd.db-wal'))
  log(!p4.ok, '过小的 WAL 被拒（调用方按「不合并」处理）', p4.ok ? '' : p4.error)
  const badMagic = Buffer.alloc(32 + 24 + PAGE_SIZE)
  badMagic.writeUInt32BE(0x12345678, 0)
  writeFileSync(join(work, 'e.db-wal'), badMagic)
  const p5 = parseWalFrames(join(work, 'e.db-wal'))
  log(!p5.ok && /魔数/.test(p5.error ?? ''), '魔数不对被拒', p5.ok ? '' : p5.error)
  const missing = parseWalFrames(join(work, 'nope.db-wal'))
  log(!missing.ok, 'WAL 不存在被拒（调用方跳过合并）')

  console.log('\n[5] 常量与派生参数')
  log(PAGE_SIZE === 4096 && ENC_SIZE === 4016, '页 4096 / 加密区 4016')
  log(KDF_ITERATIONS === 256000, 'PBKDF2 迭代 256000')
  const keyA = deriveEncryptionKey(Buffer.from('k'.repeat(32)), Buffer.from('s'.repeat(16)))
  const keyB = deriveEncryptionKey(Buffer.from('k'.repeat(32)), Buffer.from('s'.repeat(16)))
  log(keyA.length === 32 && keyA.equals(keyB), '派生确定且 32 字节')
  const macA = deriveMacKey(keyA, Buffer.from('s'.repeat(16)))
  log(macA.length === 32 && !macA.equals(keyA), 'HMAC key 与加密 key 不同（salt^0x3a）')
  log(createHash('md5').update('x').digest('hex').length === 32, '（无关断言：hash 长度齐全，防脚本被截断）')
} finally {
  try {
    rmSync(work, { recursive: true, force: true })
  } catch {
    /* Windows 偶发占用：不影响结论 */
  }
  try {
    rmSync(bundleDir, { recursive: true, force: true })
  } catch {
    /* 同上 */
  }
}

console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项未通过 ❌`)
process.exit(failed === 0 ? 0 : 1)
