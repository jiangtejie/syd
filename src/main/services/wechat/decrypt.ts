import Database from 'better-sqlite3-multiple-ciphers'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { createHash, createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { getCachePath } from '../paths'

/**
 * 微信 4.x（xwechat）加密库解密层。
 *
 * 腾讯魔改 SQLCipher 格式（2026-09-02 真实库逐页验证）：
 * - 页大小 4096，reserve=80（IV 16 + HMAC-SHA512 64）
 * - 页 1：文件前 16B 为 salt；加密区 = file[16 : 4016]（4000B）；
 *   解密后需补写标准头 `SQLite format 3\0`
 * - 页 N（N>1）：加密区 = page[0 : 4016]
 * - 每页 IV 存于 page[4016 : 4032]，HMAC 存于 page[4032 : 4096]（本层只解密，不校验 HMAC）
 * - AES key = PBKDF2-HMAC-SHA512(encKey, salt, iter=256000, dklen=32)
 *
 * WAL（真实库验证）：
 * - 布局 = 32B header + N×(24B 帧头 + 4096B 帧页)，帧头明文（pgno/commit/salt1/salt2）
 * - 帧页加密与主库页 N>1 完全相同（同 key、IV 在帧页尾部 reserve）
 * - 帧头 salt1 每周期恒定（salt2 逐帧变化）；文件头部周期 = 最后写入批次
 * - 实测微信 checkpoint 极频繁（每周期 commit == 主库页数），主库文件已是最新；
 *   仍实现「合并文件头第一周期帧」作为兜底（覆盖无副作用，增量通常为 0）
 */

const PAGE = 4096
const RESERVE = 80
const ENC_LEN = PAGE - RESERVE // 4016
const SQLITE_HEADER = Buffer.from('SQLite format 3\u0000', 'ascii')
const HEX_KEY_RE = /^[0-9a-fA-F]{64}$/
const WAL_HEADER = 32
const FRAME_HEADER = 24

export interface DecryptResult {
  ok: boolean
  error?: string
}

/** 逐页 AES-256-CBC 解密主库，返回明文 Buffer（含派生好的 aesKey，供 WAL 合并复用） */
function decryptMainDbToBuffer(
  filePath: string,
  hexKey: string
): { ok: true; buffer: Buffer; aesKey: Buffer } | { ok: false; error: string } {
  let raw: Buffer
  try {
    raw = readFileSync(filePath)
  } catch (e: any) {
    return { ok: false, error: `读取数据库失败（微信可能在占用该文件，请退出微信后重试）: ${e?.message || String(e)}` }
  }
  if (raw.length < PAGE || raw.length % PAGE !== 0) {
    return { ok: false, error: `文件大小 ${raw.length} 非 4096 页对齐，可能不是微信 4.x 加密库` }
  }

  const encKey = Buffer.from(hexKey, 'hex')
  const salt = raw.subarray(0, 16)
  const aesKey = pbkdf2Sync(encKey, salt, 256000, 32, 'sha512')
  const out = Buffer.alloc(raw.length)
  const pageCount = raw.length / PAGE

  for (let p = 1; p <= pageCount; p++) {
    const base = (p - 1) * PAGE
    const isPage1 = p === 1
    const encStart = isPage1 ? base + 16 : base
    const ivStart = base + ENC_LEN
    const decipher = createDecipheriv('aes-256-cbc', aesKey, raw.subarray(ivStart, ivStart + 16))
    decipher.setAutoPadding(false)
    const plain = Buffer.concat([decipher.update(raw.subarray(encStart, ivStart)), decipher.final()])
    if (isPage1) {
      SQLITE_HEADER.copy(out, base)
      plain.copy(out, base + 16)
    } else {
      plain.copy(out, base)
    }
  }
  return { ok: true, buffer: out, aesKey }
}

/**
 * 合并 WAL 文件头第一周期帧到主库明文。
 * 失败（无 wal/格式异常）一律返回主库原样，绝不影响主路径。
 */
function mergeWalFrames(mainBuffer: Buffer, dbFilePath: string, aesKey: Buffer): Buffer {
  try {
    const walPath = dbFilePath + '-wal'
    if (!existsSync(walPath)) return mainBuffer
    const wal = readFileSync(walPath)
    if (wal.length < WAL_HEADER + FRAME_HEADER + PAGE) return mainBuffer

    const frameSize = FRAME_HEADER + PAGE
    const totalFrames = Math.floor((wal.length - WAL_HEADER) / frameSize)
    if (totalFrames <= 0) return mainBuffer

    // 头部第一周期帧：salt1 恒定（salt2 逐帧变化，不作为周期键）
    const headKey = wal.subarray(WAL_HEADER + 8, WAL_HEADER + 16).toString('hex')
    const headFrames: { pgno: number; commit: number; offset: number }[] = []
    for (let i = 0; i < totalFrames; i++) {
      const off = WAL_HEADER + i * frameSize
      const s1 = wal.subarray(off + 8, off + 16).toString('hex')
      if (s1 !== headKey) break
      headFrames.push({ pgno: wal.readUInt32BE(off), commit: wal.readUInt32BE(off + 4), offset: off })
    }
    if (headFrames.length === 0) return mainBuffer

    let out = Buffer.from(mainBuffer)
    let maxCommitSize = 0
    for (const f of headFrames) {
      // 页1 保留主库解密结果（含 db header）；pgno 无效帧跳过
      if (f.pgno === 0 || f.pgno > 0x40000000 || f.pgno === 1) continue
      const pageData = wal.subarray(f.offset + FRAME_HEADER, f.offset + FRAME_HEADER + PAGE)
      const decipher = createDecipheriv('aes-256-cbc', aesKey, pageData.subarray(ENC_LEN, ENC_LEN + 16))
      decipher.setAutoPadding(false)
      const plain = Buffer.concat([decipher.update(pageData.subarray(0, ENC_LEN)), decipher.final()])
      const abs = (f.pgno - 1) * PAGE
      if (abs + PAGE > out.length) {
        // WAL 使库增大（主库尚未 checkpoint 到的新页）：扩展后用 commit 帧修正 db size
        const grown = Buffer.alloc(abs + PAGE)
        out.copy(grown)
        out = grown
      }
      plain.copy(out, abs)
      if (f.commit > maxCommitSize) maxCommitSize = f.commit
    }
    if (maxCommitSize > 0) out.writeUInt32BE(maxCommitSize, 28) // 页1 db size 字段（BE）
    return out
  } catch {
    return mainBuffer
  }
}

/** 解密微信库（主库 + WAL 合并）为完整明文，输出到 outPath */
export function decryptWxDbFile(filePath: string, hexKey: string, outPath: string): DecryptResult {
  const pathError = assertDbFileExists(filePath)
  if (pathError) return { ok: false, error: pathError }
  if (!HEX_KEY_RE.test(hexKey)) return { ok: false, error: '密钥格式无效（应为 64 位十六进制）' }

  const result = decryptMainDbToBuffer(filePath, hexKey)
  if (!result.ok) return { ok: false, error: result.error }
  const buffer = mergeWalFrames(result.buffer, filePath, result.aesKey)
  try {
    writeFileSync(outPath, buffer)
  } catch (e: any) {
    return { ok: false, error: `写入明文库失败: ${e?.message || String(e)}` }
  }
  return { ok: true }
}

/** 打开微信加密库：解密（含 WAL 合并）到缓存明文库后用 better-sqlite3 打开 */
export function openWxDbFile(
  filePath: string,
  hexKey: string
): { db?: Database.Database; error?: string } {
  const pathError = assertDbFileExists(filePath)
  if (pathError) return { error: pathError }
  if (!HEX_KEY_RE.test(hexKey)) return { error: '密钥格式无效（应为 64 位十六进制）' }

  const tmpPath = getPlainDbPath(filePath, hexKey)
  const decrypted = decryptWxDbFile(filePath, hexKey, tmpPath)
  if (!decrypted.ok) return { error: decrypted.error }

  try {
    const db = new Database(tmpPath, { readonly: true })
    db.prepare('SELECT count(*) AS n FROM sqlite_master').get()
    return { db }
  } catch (e: any) {
    return { error: `明文库打开失败（密钥可能错误）: ${e?.message || String(e)}` }
  }
}

/** 生成稳定的明文库缓存路径（同一源库 + key 复用同一文件，重复打开会覆盖刷新） */
function getPlainDbPath(filePath: string, hexKey: string): string {
  const hash = createHash('md5')
    .update(filePath.toLowerCase() + '|' + hexKey)
    .digest('hex')
    .slice(0, 16)
  const name = basename(filePath).replace(/\.db$/i, '') + '_' + hash + '.db'
  const dir = join(getCachePath(), 'wx-plain')
  mkdirSync(dir, { recursive: true })
  return join(dir, name)
}

function assertDbFileExists(filePath: string): string | null {
  if (!filePath) return '数据库路径为空'
  if (!isAbsolute(filePath)) return `数据库路径不是绝对路径: ${filePath}`
  if (!existsSync(filePath)) return `数据库文件不存在: ${filePath}`
  return null
}
