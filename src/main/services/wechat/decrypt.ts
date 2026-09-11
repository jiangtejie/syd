import Database from 'better-sqlite3-multiple-ciphers'
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { createHash } from 'node:crypto'
import { getConfigBoolean, getConfigNumber } from '../../db/repos/config'
import { getPlainDbDir } from '../paths'
import {
  decryptPage,
  deriveEncryptionKey,
  ENC_SIZE,
  hasSqliteHeader,
  KEY_HEX_RE,
  normalizeKey,
  PAGE_SIZE,
  SALT_SIZE,
  verifyPage1
} from './crypto/sqlcipher'
import { mergeWalIntoPlainFile, type WalSummary } from './crypto/wal'

/**
 * 微信 4.x（xwechat）加密库解密层（门面）。
 *
 * 密码学常量与页解密在 crypto/sqlcipher.ts，WAL 帧解析/校验/合并在 crypto/wal.ts；
 * 本文件只负责编排：密钥校验 → 流式解密写盘 → WAL 合并 → 明文副本缓存治理。
 *
 * 三条与旧实现的关键差异：
 * 1. **先校验密钥**（只读一页做 HMAC）—— 密钥错立刻报「密钥不正确」，不必解密整库再失败；
 * 2. **流式批量写盘**（128 页/批）—— 旧实现整块读 + 整块分配，4GB 消息库会吃到 8GB+ 内存；
 * 3. **WAL 带校验和合并**（只应用到最后一个 commit 帧 + 按 nTruncate 截断 + 含页 1）——
 *    旧实现不校验、只取第一周期、跳过页 1，读到撕裂帧会把坏页写进副本。
 *
 * 回退开关：`wechat.decrypt.legacy=1` 走旧的内存整块路径（出问题时可一键降级）。
 */

/** 单批解密页数：512KB/次写入，兼顾大库内存与写盘次数 */
const BATCH_PAGES = 128
/** 明文副本缓存上限（超出按最旧淘汰）：默认 3GB / 20 个文件 */
const DEFAULT_CACHE_MAX_MB = 3072
const DEFAULT_CACHE_MAX_FILES = 20

export interface DecryptResult {
  ok: boolean
  error?: string
  /** 本次合并的 WAL 摘要（无 WAL 时为 undefined） */
  wal?: WalSummary
  /** 是否命中了新鲜副本（未真正解密） */
  cached?: boolean
}

export interface KeyCheckResult {
  ok: boolean
  error?: string
}

function assertDbFileExists(filePath: string): string | null {
  if (!filePath) return '数据库路径为空'
  if (!isAbsolute(filePath)) return `数据库路径不是绝对路径: ${filePath}`
  if (!existsSync(filePath)) return `数据库文件不存在: ${filePath}`
  return null
}

/** 读满 count 字节；返回实际读到的字节数 */
function readInto(fd: number, buf: Buffer, position: number): number {
  let read = 0
  while (read < buf.length) {
    const n = readSync(fd, buf, read, buf.length - read, position + read)
    if (n <= 0) break
    read += n
  }
  return read
}

/**
 * 只用第一页校验密钥是否正确（HMAC）。
 * 用途：设置页「测试连接」即时反馈；解密前 fail-fast，避免解完整库才发现密钥错。
 */
export function verifyWxDbKey(filePath: string, hexKey: string): KeyCheckResult {
  const pathError = assertDbFileExists(filePath)
  if (pathError) return { ok: false, error: pathError }
  const key = normalizeKey(hexKey)
  if (!key) return { ok: false, error: '密钥格式无效（应为 64 位十六进制）' }
  let fd: number | null = null
  try {
    fd = openSync(filePath, 'r')
    const page = Buffer.alloc(PAGE_SIZE)
    if (readInto(fd, page, 0) < PAGE_SIZE)
      return { ok: false, error: '文件不足一页，可能不是微信 4.x 加密库' }
    if (!verifyPage1(page, key)) {
      return { ok: false, error: '密钥不正确（第一页 HMAC 校验失败）' }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/** 流式批量解密主库到 outPath（内存占用与库大小无关） */
function decryptMainDbStreaming(
  filePath: string,
  outPath: string,
  encryptionKey: Buffer
): { ok: true; pages: number } | { ok: false; error: string } {
  let inFd: number | null = null
  let outFd: number | null = null
  try {
    const size = statSync(filePath).size
    if (size < PAGE_SIZE || size % PAGE_SIZE !== 0) {
      return { ok: false, error: `文件大小 ${size} 非 4096 页对齐，可能不是微信 4.x 加密库` }
    }
    const pages = size / PAGE_SIZE
    inFd = openSync(filePath, 'r')
    outFd = openSync(outPath, 'w')
    const page = Buffer.alloc(PAGE_SIZE)
    let batch: Buffer[] = []
    for (let p = 1; p <= pages; p += 1) {
      if (readInto(inFd, page, (p - 1) * PAGE_SIZE) < PAGE_SIZE) {
        return { ok: false, error: `读取第 ${p} 页不完整（微信可能正在写入该库）` }
      }
      batch.push(decryptPage(page, encryptionKey, p))
      if (batch.length >= BATCH_PAGES) {
        writeSync(outFd, Buffer.concat(batch, batch.length * PAGE_SIZE))
        batch = []
      }
    }
    if (batch.length > 0) writeSync(outFd, Buffer.concat(batch, batch.length * PAGE_SIZE))
    return { ok: true, pages }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: `写入明文库失败: ${msg}` }
  } finally {
    if (outFd !== null) closeSync(outFd)
    if (inFd !== null) closeSync(inFd)
  }
}

/** 旧路径（内存整块）：仅供 `wechat.decrypt.legacy=1` 回退使用 */
function decryptMainDbToBufferLegacy(
  filePath: string,
  encryptionKey: Buffer
): { ok: true; buffer: Buffer } | { ok: false; error: string } {
  try {
    const raw = readFileSyncSafe(filePath)
    if (raw.length < PAGE_SIZE || raw.length % PAGE_SIZE !== 0) {
      return { ok: false, error: `文件大小 ${raw.length} 非 4096 页对齐，可能不是微信 4.x 加密库` }
    }
    const out = Buffer.alloc(raw.length)
    const pageCount = raw.length / PAGE_SIZE
    for (let p = 1; p <= pageCount; p += 1) {
      const base = (p - 1) * PAGE_SIZE
      const page = raw.subarray(base, base + PAGE_SIZE)
      decryptPage(page, encryptionKey, p).copy(out, base)
    }
    return { ok: true, buffer: out }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function readFileSyncSafe(filePath: string): Buffer {
  const fd = openSync(filePath, 'r')
  try {
    const size = fstatSync(fd).size
    const buf = Buffer.alloc(size)
    readInto(fd, buf, 0)
    return buf
  } finally {
    closeSync(fd)
  }
}

/**
 * 解密微信库（主库 + WAL 合并）到 outPath。
 * 任何一步失败都返回明确原因；WAL 合并失败只降级为「不合并」并附 warning。
 */
export function decryptWxDbFile(filePath: string, hexKey: string, outPath: string): DecryptResult {
  const pathError = assertDbFileExists(filePath)
  if (pathError) return { ok: false, error: pathError }
  const key = normalizeKey(hexKey)
  if (!key) return { ok: false, error: '密钥格式无效（应为 64 位十六进制）' }

  // 1) 先校验密钥（只读一页）
  const check = verifyWxDbKey(filePath, hexKey)
  if (!check.ok) return { ok: false, error: check.error }

  // 2) 派生 AES key（salt 取文件首 16 字节）
  let salt: Buffer
  try {
    const fd = openSync(filePath, 'r')
    try {
      const head = Buffer.alloc(SALT_SIZE)
      readInto(fd, head, 0)
      salt = head
    } finally {
      closeSync(fd)
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  const encryptionKey = deriveEncryptionKey(key, salt)

  const legacy = getConfigBoolean('wechat.decrypt.legacy', false)
  let pages = 0
  if (legacy) {
    const buf = decryptMainDbToBufferLegacy(filePath, encryptionKey)
    if (!buf.ok) return { ok: false, error: buf.error }
    let outFd: number | null = null
    try {
      outFd = openSync(outPath, 'w')
      writeSync(outFd, buf.buffer)
    } catch (e) {
      if (outFd !== null) closeSync(outFd)
      return { ok: false, error: `写入明文库失败: ${e instanceof Error ? e.message : String(e)}` }
    }
    if (outFd !== null) closeSync(outFd)
    pages = buf.buffer.length / PAGE_SIZE
  } else {
    const streamed = decryptMainDbStreaming(filePath, outPath, encryptionKey)
    if (!streamed.ok) return { ok: false, error: streamed.error }
    pages = streamed.pages
  }

  // 3) WAL 合并（微信上通常是 no-op：checkpoint 后当前日志为空）
  let wal = mergeWalIntoPlainFile(`${filePath}-wal`, outPath, encryptionKey)

  // 4) 明文副本自检 + 缓存治理
  if (!isPlainFileUsable(outPath)) {
    return { ok: false, error: '解密产物不是有效的 SQLite 库（密钥或库文件可能异常）' }
  }

  // 5) 真合并过就做一次结构自检：不通过则丢弃合并结果（回落主库解密），避免坏页留在副本里
  if (wal.merged) {
    const check = quickCheckPlainDb(outPath)
    if (!check.ok) {
      const redone = legacy
        ? decryptMainDbToBufferLegacy(filePath, encryptionKey)
        : decryptMainDbStreaming(filePath, outPath, encryptionKey)
      wal = {
        ...wal,
        appliedFrames: 0,
        merged: false,
        warning: `WAL 合并结果未通过 quick_check（${check.error ?? '未知'}），已丢弃合并结果`
      }
      if (!redone.ok) return { ok: false, error: redone.error }
    }
  }

  prunePlainDbCache(outPath)
  void pages
  return { ok: true, wal }
}

/** 用 SQLite 自身的完整性检查兜底（只在真正合并过 WAL 时跑一次） */
function quickCheckPlainDb(plainPath: string): { ok: boolean; error?: string } {
  let db: Database.Database | null = null
  try {
    db = new Database(plainPath, { readonly: true })
    const rows = db.prepare('PRAGMA quick_check').all() as Array<{ quick_check?: string }>
    const first = rows[0]?.quick_check ?? 'ok'
    return first.toLowerCase() === 'ok' ? { ok: true } : { ok: false, error: first }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    try {
      db?.close()
    } catch {
      /* ignore */
    }
  }
}

/** 明文产物是否可用：头部必须是 SQLite 标准头 */
function isPlainFileUsable(plainPath: string): boolean {
  try {
    const fd = openSync(plainPath, 'r')
    try {
      const head = Buffer.alloc(16)
      readInto(fd, head, 0)
      return hasSqliteHeader(head)
    } finally {
      closeSync(fd)
    }
  } catch {
    return false
  }
}

/* ── 明文副本缓存 ── */

function stampOf(filePath: string): { mtimeMs: number; size: number } | null {
  try {
    const st = statSync(filePath)
    return { mtimeMs: st.mtimeMs, size: st.size }
  } catch {
    return null
  }
}

/**
 * 源库签名（含 -wal）：主库与 WAL 任一变化都算「源变了」。
 * 旧实现只比 mtime 与主库大小，WAL 追加写入但主库 mtime 未变时会误判为新鲜。
 */
function sourceSignature(filePath: string): string | null {
  const main = stampOf(filePath)
  if (!main) return null
  const wal = stampOf(`${filePath}-wal`)
  return `${main.size}:${main.mtimeMs}|${wal ? `${wal.size}:${wal.mtimeMs}` : '-'}`
}

/** 明文副本是否仍然新鲜（源库 + WAL 都没有比它更新的改动，且副本不小于主库） */
function isPlainCacheFresh(filePath: string, plainPath: string): boolean {
  const plain = stampOf(plainPath)
  if (!plain || plain.size === 0) return false
  const main = stampOf(filePath)
  if (!main) return false
  const wal = stampOf(`${filePath}-wal`)
  const srcMtime = Math.max(main.mtimeMs, wal?.mtimeMs ?? 0)
  return plain.mtimeMs >= srcMtime && plain.size >= main.size && isPlainFileUsable(plainPath)
}

/**
 * 缓存淘汰：明文副本按 (库,密钥) 各存一份，长期运行会越堆越多 —— 超上限按最旧淘汰。
 * 当前正在使用的副本不删；删除失败（被占用）忽略，下轮再试。
 */
export function prunePlainDbCache(keepPath?: string): { removed: number; freedBytes: number } {
  const maxBytes =
    Math.max(0, getConfigNumber('wechat.plainCacheMaxMB', DEFAULT_CACHE_MAX_MB)) * 1024 * 1024
  const maxFiles = Math.max(
    1,
    getConfigNumber('wechat.plainCacheMaxFiles', DEFAULT_CACHE_MAX_FILES)
  )
  let removed = 0
  let freedBytes = 0
  try {
    const dir = getPlainDbDir()
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.db'))
      .map((e) => {
        const full = join(dir, e.name)
        const st = statSync(full)
        return { full, size: st.size, mtimeMs: st.mtimeMs }
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs)
    let total = entries.reduce((sum, e) => sum + e.size, 0)
    let count = entries.length
    for (const e of entries) {
      if (total <= maxBytes && count <= maxFiles) break
      if (keepPath && e.full === keepPath) continue
      try {
        unlinkSync(e.full)
        total -= e.size
        count -= 1
        removed += 1
        freedBytes += e.size
      } catch {
        /* 被占用：跳过，下轮再试 */
      }
    }
  } catch {
    /* 目录不存在等：无需处理 */
  }
  return { removed, freedBytes }
}

/** 生成稳定的明文库缓存路径（同一源库 + key 复用同一文件，重复打开会覆盖刷新） */
function getPlainDbPath(filePath: string, hexKey: string): string {
  const hash = createHash('md5')
    .update(filePath.toLowerCase() + '|' + hexKey)
    .digest('hex')
    .slice(0, 16)
  const name = basename(filePath).replace(/\.db$/i, '') + '_' + hash + '.db'
  return join(getPlainDbDir(), name)
}

/** 打开微信加密库：明文副本新鲜则直接打开，否则解密（含 WAL 合并）后打开 */
export function openWxDbFile(
  filePath: string,
  hexKey: string
): { db?: Database.Database; error?: string } {
  const pathError = assertDbFileExists(filePath)
  if (pathError) return { error: pathError }
  if (!KEY_HEX_RE.test((hexKey || '').trim())) {
    return { error: '密钥格式无效（应为 64 位十六进制）' }
  }

  const tmpPath = getPlainDbPath(filePath, hexKey)
  if (!isPlainCacheFresh(filePath, tmpPath)) {
    const decrypted = decryptWxDbFile(filePath, hexKey, tmpPath)
    if (!decrypted.ok) return { error: decrypted.error }
  }

  try {
    const db = new Database(tmpPath, { readonly: true })
    db.prepare('SELECT count(*) AS n FROM sqlite_master').get()
    return { db }
  } catch (e) {
    return { error: `明文库打开失败: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** 供诊断/自检：当前源库签名（源库或 WAL 变化即变化） */
export function wechatSourceSignature(filePath: string): string | null {
  return sourceSignature(filePath)
}

/** 加密区长度导出（自检与外部校验用） */
export { ENC_SIZE, PAGE_SIZE }
