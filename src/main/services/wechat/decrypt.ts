import Database from 'better-sqlite3-multiple-ciphers'
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { createHash } from 'node:crypto'
import { getConfigBoolean, getConfigNumber } from '../../db/repos/config'
import { getPlainDbDir } from '../paths'
import { createLogger } from '../logging'
import {
  decryptPage,
  deriveEncryptionKey,
  deriveFileMacKey,
  ENC_SIZE,
  hasSqliteHeader,
  KEY_HEX_RE,
  normalizeKey,
  PAGE_SIZE,
  SALT_SIZE,
  verifyPage,
  verifyPage1
} from './crypto/sqlcipher'
import { mergeWalIntoPlainFile, type WalSummary } from './crypto/wal'
import { shouldRefreshFromWal } from './dbFileWatch'

const decryptLog = createLogger('wechat-decrypt')

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

 */

/** 单批解密页数：512KB/次写入，兼顾大库内存与写盘次数 */
const BATCH_PAGES = 128
/** 明文副本缓存上限（超出按最旧淘汰）：默认 3GB / 20 个文件 */
const DEFAULT_CACHE_MAX_MB = 3072
const DEFAULT_CACHE_MAX_FILES = 20
/**
 * 解密期源库发生变化 / 读到撕裂页时，最多再重解 N 次。
 * 为什么要有这个：微信边写我们边读时，AES-CBC 无 padding、单页不校验也能「解出东西」，
 * 坏页会静默写进副本并被当成新鲜缓存长期使用。逐页 HMAC 能精确发现，重解一次即可拿到一致快照。
 */
const MAX_SOURCE_RETRY = 1

export interface DecryptResult {
  ok: boolean
  error?: string
  /** 本次合并的 WAL 摘要（无 WAL 时为 undefined） */
  wal?: WalSummary
  /** 是否命中了新鲜副本（未真正解密） */
  cached?: boolean
  /** 解出的页数（诊断/日志用） */
  pages?: number
  /** 解密期间源库仍在变化（已尽力重解，副本是「某一时刻」的一致快照） */
  staleSource?: boolean
  /** 源库本身已是明文库（未做解密，直接只读打开源文件） */
  plaintext?: boolean
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

/**
 * 流式批量解密主库到 outPath（内存占用与库大小无关）。
 * verifyPages=true 时逐页校验 HMAC：这是**唯一**能精确发现「读到撕裂页」的手段
 * （页间无 padding、解密不会报错，坏页会安静地变成垃圾数据）。
 */
function decryptMainDbStreaming(
  filePath: string,
  outPath: string,
  encryptionKey: Buffer,
  macKey: Buffer,
  verifyPages: boolean
): { ok: true; pages: number } | { ok: false; error: string; torn?: boolean } {
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
        return { ok: false, error: `读取第 ${p} 页不完整（微信可能正在写入该库）`, torn: true }
      }
      if (verifyPages && !verifyPage(page, macKey, p)) {
        return {
          ok: false,
          error: `第 ${p}/${pages} 页 HMAC 校验失败（读到的不是完整页，微信可能正在写入该库）`,
          torn: true
        }
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

/** 解密一次（写 tmp → WAL 合并 → 结构自检），失败返回原因；torn=true 表示读到了撕裂页 */
function decryptOnce(
  filePath: string,
  tmpPath: string,
  encryptionKey: Buffer,
  macKey: Buffer,
  verifyPages: boolean
): { ok: true; pages: number; wal: WalSummary } | { ok: false; error: string; torn?: boolean } {
  const writeMain = ():
    { ok: true; pages: number } | { ok: false; error: string; torn?: boolean } =>
    decryptMainDbStreaming(filePath, tmpPath, encryptionKey, macKey, verifyPages)

  const written = writeMain()
  if (!written.ok) return written

  // WAL 合并（微信上通常是 no-op：checkpoint 后当前日志为空）
  let wal = mergeWalIntoPlainFile(`${filePath}-wal`, tmpPath, encryptionKey)

  if (!isPlainFileUsable(tmpPath)) {
    return { ok: false, error: '解密产物不是有效的 SQLite 库（密钥或库文件可能异常）' }
  }

  // 真合并过就做一次结构自检：不通过则丢弃合并结果（回落主库解密），避免坏页留在副本里
  if (wal.merged) {
    const check = quickCheckPlainDb(tmpPath)
    if (!check.ok) {
      const redone = writeMain()
      wal = {
        ...wal,
        appliedFrames: 0,
        merged: false,
        warning: `WAL 合并结果未通过 quick_check（${check.error ?? '未知'}），已丢弃合并结果`
      }
      if (!redone.ok) return redone
    }
  }
  return { ok: true, pages: written.pages, wal }
}

/**
 * 解密微信库（主库 + WAL 合并）到 outPath。
 *
 * 编排：密钥校验 → 分段解密（逐页 HMAC，默认开）→ WAL 合并 → 结构自检 → **原子落盘** → 缓存治理。
 * 源库在解密期间仍在写入时最多重解 MAX_SOURCE_RETRY 次（先按撕裂页判据，再按签名变化判据）；
 * 仍不稳定就带着 staleSource 标记返回 —— 副本本身是一致的某一时刻快照，比读坏页安全得多。
 */
export function decryptWxDbFile(filePath: string, hexKey: string, outPath: string): DecryptResult {
  const pathError = assertDbFileExists(filePath)
  if (pathError) return { ok: false, error: pathError }
  const key = normalizeKey(hexKey)
  if (!key) return { ok: false, error: '密钥格式无效（应为 64 位十六进制）' }

  // 1) 先校验密钥（只读一页）
  const check = verifyWxDbKey(filePath, hexKey)
  if (!check.ok) return { ok: false, error: check.error }

  // 2) 派生 AES / MAC key（salt 取文件首 16 字节）
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
  const macKey = deriveFileMacKey(key, salt)
  const verifyPages = getConfigBoolean('wechat.decrypt.verifyPages', true)

  const tmpPath = `${outPath}.part`
  const name = basename(filePath)
  let staleSource = false

  for (let attempt = 0; attempt <= MAX_SOURCE_RETRY; attempt += 1) {
    const started = Date.now()
    const sigBefore = sourceSignature(filePath)
    const once = decryptOnce(filePath, tmpPath, encryptionKey, macKey, verifyPages)

    if (!once.ok) {
      safeUnlink(tmpPath)
      if (once.torn && attempt < MAX_SOURCE_RETRY) {
        decryptLog.info(`${name}: 解密期间读到撕裂页，重解（${once.error}）`)
        continue
      }
      decryptLog.warn(`${name}: 解密失败 — ${once.error}`)
      return { ok: false, error: once.error }
    }

    const sigAfter = sourceSignature(filePath)
    const changed = !!sigBefore && !!sigAfter && sigBefore !== sigAfter
    if (changed && attempt < MAX_SOURCE_RETRY) {
      decryptLog.info(`${name}: 解密期间源库仍在写入，重解一次`)
      continue
    }
    staleSource = changed

    try {
      renameSync(tmpPath, outPath) // 原子替换：读者要么看到旧副本，要么看到新副本，不会看到半截文件
    } catch (e) {
      safeUnlink(tmpPath)
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, error: `明文副本落盘失败: ${msg}` }
    }

    decryptLog.debug(
      `${name} → ${basename(outPath)}：${once.pages} 页，${Date.now() - started}ms` +
        `，WAL 合并=${once.wal.merged}${staleSource ? '，源库仍在变化（副本为该时刻一致快照）' : ''}`
    )
    prunePlainDbCache(outPath)
    return { ok: true, wal: once.wal, pages: once.pages, staleSource }
  }

  return { ok: false, error: '源库持续被写入，解密未能取得一致快照，请稍后重试' }
}

function safeUnlink(p: string): void {
  try {
    unlinkSync(p)
  } catch {
    /* 不存在或被占用：忽略 */
  }
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
    // 顺手清掉上次崩溃留下的半截文件（解密已改为写 .part 再原子改名）
    for (const leftover of readdirSync(dir)) {
      if (!leftover.toLowerCase().endsWith('.part')) continue
      const full = join(dir, leftover)
      try {
        if (Date.now() - statSync(full).mtimeMs > 60 * 60 * 1000) unlinkSync(full)
      } catch {
        /* 被占用：下轮再试 */
      }
    }
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

/**
 * 清空明文库副本缓存（退出时可选调用，见 security.clearPlainCacheOnExit 开关）。
 *
 * 为什么默认**不**在退出时清：明文副本是解密缓存，清了意味着下次启动要把每个消息库
 * （几百 MB × 分片数）重新完整 AES 解密一遍 —— 对一个每天开机的客服工具，这个代价换来的是
 * 「关机后磁盘上少一份明文」。**默认保留**，把选择权交给对机器物理安全有要求的用户。
 * 相比之下注入截图默认就清：那里面是客户聊天画面，且没有缓存价值。
 */
export function clearPlainDbCache(): { removed: number; freedBytes: number } {
  let removed = 0
  let freedBytes = 0
  try {
    const dir = getPlainDbDir()
    for (const name of readdirSync(dir)) {
      const lower = name.toLowerCase()
      if (!lower.endsWith('.db') && !lower.endsWith('.part')) continue
      const full = join(dir, name)
      try {
        const size = statSync(full).size
        unlinkSync(full)
        removed += 1
        freedBytes += size
      } catch {
        /* 被占用：跳过 */
      }
    }
  } catch {
    /* 目录不存在等：无需处理 */
  }
  return { removed, freedBytes }
}

/** 生成稳定的明文库缓存路径（同一源库 + key 复用同一文件，重复打开会覆盖刷新） */
export function getPlainDbPath(filePath: string, hexKey: string): string {
  const hash = createHash('md5')
    .update(filePath.toLowerCase() + '|' + hexKey)
    .digest('hex')
    .slice(0, 16)
  const name = basename(filePath).replace(/\.db$/i, '') + '_' + hash + '.db'
  return join(getPlainDbDir(), name)
}

/** 源库是否本身就是明文库（页 1 前 16 字节是标准 SQLite 头） */
function isPlainSource(filePath: string): boolean {
  try {
    const fd = openSync(filePath, 'r')
    try {
      const head = Buffer.alloc(16)
      if (readInto(fd, head, 0) < 16) return false
      return hasSqliteHeader(head)
    } finally {
      closeSync(fd)
    }
  } catch {
    return false
  }
}

/** 只读打开并做一次最小可用性探测（避免把「能打开但读不了」的库交出去） */
function openReadonly(path: string): { db?: Database.Database; error?: string } {
  try {
    const db = new Database(path, { readonly: true })
    db.prepare('SELECT count(*) AS n FROM sqlite_master').get()
    return { db }
  } catch (e) {
    return { error: `明文库打开失败: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/**
 * 打开微信库：明文副本新鲜则直接打开，否则解密（含 WAL 合并）后打开。
 *
 * 两条兜底路径都是「闭环」的一部分：
 * - 源库已是明文（用户指向已解密副本、或旧版本库）→ 直接用源文件，不需要密钥也不需要副本；
 * - 副本打不开（半截写/坏页/新鲜度误判）→ 丢弃副本重解一次，避免坏副本被长期当成新鲜缓存。
 */
export function openWxDbFile(
  filePath: string,
  hexKey: string
): { db?: Database.Database; error?: string; plaintext?: boolean } {
  const pathError = assertDbFileExists(filePath)
  if (pathError) return { error: pathError }

  if (isPlainSource(filePath)) {
    const direct = openReadonly(filePath)
    return direct.db ? { db: direct.db, plaintext: true } : direct
  }

  if (!KEY_HEX_RE.test((hexKey || '').trim())) {
    return { error: '密钥格式无效（应为 64 位十六进制）' }
  }

  const plainPath = getPlainDbPath(filePath, hexKey)
  if (!isPlainCacheFresh(filePath, plainPath)) {
    // 先试增量：只有 WAL 追加（主库没动）时把新帧合进已有副本，省掉整库重解。
    // 任何不成立的情形都返回 false —— 那时原样走整库重解，与升级前行为完全一致。
    if (!refreshPlainFromWal(filePath, plainPath, hexKey)) {
      const decrypted = decryptWxDbFile(filePath, hexKey, plainPath)
      if (!decrypted.ok) return { error: decrypted.error }
    }
  }

  const first = openReadonly(plainPath)
  if (first.db) return first

  decryptLog.warn(`明文副本不可用，丢弃后重解: ${basename(plainPath)} — ${first.error}`)
  safeUnlink(plainPath)
  const redone = decryptWxDbFile(filePath, hexKey, plainPath)
  if (!redone.ok) return { error: `${first.error}；重解后仍失败: ${redone.error}` }
  const second = openReadonly(plainPath)
  if (second.db) return second
  return { error: `${first.error}；重解后仍打不开: ${second.error}` }
}

/**
 * 明文副本的**增量刷新**：只在「主库没动、WAL 又长了一截」时，把当前日志的帧直接合并进
 * 已有副本，省掉整库 AES 重解密（几百 MB × 分片数，是主进程卡顿的主要来源）。
 *
 * 为什么是安全的：
 * - 只在 **主库没变**（plain.mtimeMs >= main.mtimeMs 且尺寸不缩水）时走这条路 ——
 *   主库自己变了说明 checkpoint 已经把页写回去了，必须整库重解；
 * - mergeWalIntoPlainFile 只处理「头部 salt == 首帧 salt」的当前日志，checkpoint 后的旧世代帧
 *   一律不合并（照合会把旧内容盖回新库）；同一批已提交帧重复应用写回的是同样的页内容，幂等；
 * - 合并后跑 quick_check，不通过就返回 false 让调用方走整库重解 —— 绝不把坏副本留在缓存里。
 *
 * 返回 true 表示副本已是最新、可以直接打开。
 */
function refreshPlainFromWal(filePath: string, plainPath: string, hexKey: string): boolean {
  if (!shouldRefreshFromWal(stampOf(filePath), stampOf(plainPath))) return false
  if (!isPlainFileUsable(plainPath)) return false
  const key = normalizeKey(hexKey)
  if (!key) return false
  let salt: Buffer
  try {
    const fd = openSync(filePath, 'r')
    try {
      salt = Buffer.alloc(SALT_SIZE)
      readInto(fd, salt, 0)
    } finally {
      closeSync(fd)
    }
  } catch {
    return false
  }
  const wal = mergeWalIntoPlainFile(`${filePath}-wal`, plainPath, deriveEncryptionKey(key, salt))
  if (!wal.merged) return false
  const check = quickCheckPlainDb(plainPath)
  if (!check.ok) {
    decryptLog.warn(
      `${basename(filePath)}: WAL 增量合并未通过 quick_check（${check.error ?? '未知'}），改走整库重解`
    )
    return false
  }
  decryptLog.debug(
    `${basename(filePath)}: 明文副本按 WAL 增量刷新（${wal.appliedFrames} 帧，未整库重解）`
  )
  return true
}

/** 供诊断/自检：当前源库签名（源库或 WAL 变化即变化） */
export function wechatSourceSignature(filePath: string): string | null {
  return sourceSignature(filePath)
}

/** 加密区长度导出（自检与外部校验用） */
export { ENC_SIZE, PAGE_SIZE }
