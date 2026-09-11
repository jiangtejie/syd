import { createDecipheriv, createHmac, pbkdf2Sync } from 'node:crypto'

/**
 * 微信 4.x（xwechat）加密库的**页级密码学纯函数**（零 IO、零内部依赖，可离线自检）。
 *
 * 从 decrypt.ts 抽出来的原因：这些常量与算法是整条读库链路的地基，之前埋在编排代码里无法单独测；
 * 现在既能被自检覆盖，也能被密钥校验（只读第一页就能判断密钥对不对）与密钥扫描复用。
 *
 * 格式（2026-09-02 真实库逐页验证，与公开实现一致）：
 * - 页 4096，尾部保留区 80B：IV 16B（[4016,4032)）+ HMAC-SHA512 64B（[4032,4096)）
 * - 页 1：文件前 16B 是 salt，加密区 = [16, 4016)；解密后需补写标准头 `SQLite format 3\0`
 * - 页 N>1：加密区 = [0, 4016)
 * - AES-256-CBC，key = PBKDF2-HMAC-SHA512(encKey, salt, 256000, 32)
 * - HMAC key = PBKDF2-HMAC-SHA512(encKey_derived, salt ^ 0x3a, 2, 32)，覆盖 [16,4032) + 页号(小端)
 */

export const PAGE_SIZE = 4096
export const RESERVE_SIZE = 80
/** 加密区长度（IV 之前） */
export const ENC_SIZE = PAGE_SIZE - RESERVE_SIZE // 4016
export const IV_OFFSET = ENC_SIZE // 4016
export const HMAC_SIZE = 64
export const HMAC_OFFSET = PAGE_SIZE - HMAC_SIZE // 4032
export const SALT_SIZE = 16
export const KDF_ITERATIONS = 256000
export const SQLITE_HEADER = Buffer.from('SQLite format 3\u0000', 'ascii')
export const KEY_HEX_RE = /^[0-9a-fA-F]{64}$/

/** 64 位十六进制密钥 → Buffer；格式不对返回 null（调用方给中文提示） */
export function normalizeKey(hexKey: string): Buffer | null {
  const s = (hexKey || '').trim()
  if (!KEY_HEX_RE.test(s)) return null
  return Buffer.from(s, 'hex')
}

export function deriveEncryptionKey(password: Buffer, salt: Buffer): Buffer {
  return pbkdf2Sync(password, salt, KDF_ITERATIONS, 32, 'sha512')
}

/** HMAC 派生：macSalt = salt 每字节异或 0x3a，迭代 2 次（SQLCipher v4 约定） */
export function deriveMacKey(encryptionKey: Buffer, salt: Buffer): Buffer {
  const macSalt = Buffer.from(salt.map((b) => b ^ 0x3a))
  return pbkdf2Sync(encryptionKey, macSalt, 2, 32, 'sha512')
}

/**
 * 校验第一页的 HMAC —— 只读一页就能判断「密钥对不对」，不必解密整库。
 * 密钥错误时返回 false（此前要等整库解密完、打开明文库失败才知道）。
 */
export function verifyPage1(page: Buffer, password: Buffer): boolean {
  if (page.length < PAGE_SIZE) return false
  const salt = page.subarray(0, SALT_SIZE)
  const macKey = deriveMacKey(deriveEncryptionKey(password, salt), salt)
  const hmac = createHmac('sha512', macKey)
  hmac.update(page.subarray(SALT_SIZE, HMAC_OFFSET))
  const pageNo = Buffer.alloc(4)
  pageNo.writeUInt32LE(1, 0)
  hmac.update(pageNo)
  return hmac.digest().equals(page.subarray(HMAC_OFFSET, PAGE_SIZE))
}

/** 解密单页（页 1 会补回 SQLite 标准头；尾部保留区原样保留 0 值） */
export function decryptPage(page: Buffer, encryptionKey: Buffer, pageNumber: number): Buffer {
  const isPage1 = pageNumber === 1
  const start = isPage1 ? SALT_SIZE : 0
  const iv = page.subarray(IV_OFFSET, IV_OFFSET + 16)
  const decipher = createDecipheriv('aes-256-cbc', encryptionKey, iv)
  decipher.setAutoPadding(false)
  const plain = Buffer.concat([decipher.update(page.subarray(start, IV_OFFSET)), decipher.final()])
  const out = Buffer.alloc(PAGE_SIZE)
  if (isPage1) {
    SQLITE_HEADER.copy(out, 0)
    plain.copy(out, SALT_SIZE)
  } else {
    plain.copy(out, 0)
  }
  return out
}

/** 明文库头判断（解密产物自检、损坏兜底用） */
export function hasSqliteHeader(buf: Buffer): boolean {
  return (
    buf.length >= SQLITE_HEADER.length &&
    buf.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)
  )
}
