import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  truncateSync,
  writeSync
} from 'node:fs'
import { decryptPage, PAGE_SIZE } from './sqlcipher'

/**
 * SQLite WAL 解析与合并（**按真实微信 4.x 库校准过**）。
 *
 * 为什么不能照抄公开实现：wx-decode（同作者另一仓库）的实现要求「帧 salt 必须等于头部 salt」
 * 且逐帧校验 checksum。实测本机 20 个真实微信 WAL 文件：**全部**是「头部 salt = 首帧 salt + 1」，
 * 按那条规则会一帧都不合并（等于静默关闭合并，比不合并更糟：看着有校验，实际从未生效）。
 *
 * 实测得到的正确语义（与 SQLite 源码一致）：
 * - SQLite 在 checkpoint 成功后「重启 WAL」：`walRestartHdr` 把 salt1 加一并把 mxFrame 归零，
 *   新帧从文件头开始写。因此：
 *   · 头部 salt == 首帧 salt  → 这些帧是**当前日志**，需要合并（正常活跃写入的情形）；
 *   · 头部 salt != 首帧 salt  → 当前日志为空（旧世代已 checkpoint 进主库），**什么都不该合并**；
 *   文件里残留的旧世代帧属于「已被 checkpoint 的内容」，照着合并等于把旧内容盖回新库。
 * - 只有当前日志的帧才能用 checksum 链校验（链的初值是头部校验和；重启后旧世代的链已不可复原），
 *   所以 checksum 校验只用在「当前日志」分支 —— 那里它是真实有效的防撕裂手段。
 *
 * 仍然保留的加固：头部 magic/页大小/校验和校验、pgno 合法性、只应用到最后一个 commit 帧、
 * 按 nTruncate 截断库大小；调用方还会在合并后跑一次 `PRAGMA quick_check`，不通过就丢弃合并结果。
 */

export const WAL_HEADER_SIZE = 32
export const FRAME_HEADER_SIZE = 24
/** SQLite WAL 魔数（低位区分 checksum 字序：0=小端、1=大端） */
const WAL_MAGIC_BASE = 0x377f0682

export interface WalFrame {
  index: number
  pgno: number
  /** 提交帧声明的库页数（0 = 非提交帧） */
  nTruncate: number
}

export interface ParsedWal {
  /** 是否为「当前日志」（头部 salt 与首帧 salt 一致，即可合并的那一段） */
  current: boolean
  frames: WalFrame[]
  /** 最后一个 commit 帧序号（0 = 无可用提交） */
  lastCommit: number
  /** 最后一个 commit 声明的库页数 */
  finalPages: number
  /** 未合并/无帧时的原因（写日志与调试用） */
  reason?: string
}

export interface WalSummary {
  framesValid: number
  lastCommitFrame: number
  appliedFrames: number
  finalPages: number
  /** 是否真的改了明文库（微信上通常是 false：主库已是最新） */
  merged: boolean
  /** 跳过合并的原因 / 合并异常 */
  warning?: string
}

/** SQLite 的滚动校验和（一次累加 8 字节 = 两个 32 位字） */
function checksumBytes(
  nativeCksum: boolean,
  data: Buffer,
  initial: [number, number]
): [number, number] {
  let s1 = initial[0]
  let s2 = initial[1]
  for (let i = 0; i + 8 <= data.length; i += 8) {
    const a = nativeCksum ? data.readUInt32LE(i) : data.readUInt32BE(i)
    const b = nativeCksum ? data.readUInt32LE(i + 4) : data.readUInt32BE(i + 4)
    s1 = (s1 + a + s2) >>> 0
    s2 = (s2 + b + s1) >>> 0
  }
  return [s1, s2]
}

function readInto(fd: number, buf: Buffer, position: number): number {
  let read = 0
  while (read < buf.length) {
    const n = readSync(fd, buf, read, buf.length - read, position + read)
    if (n <= 0) break
    read += n
  }
  return read
}

const EMPTY_WAL = (reason: string): ParsedWal => ({
  current: false,
  frames: [],
  lastCommit: 0,
  finalPages: 0,
  reason
})

/**
 * 解析 WAL：校验头部 → 判断是否为当前日志 → 在当前日志内校验逐帧 checksum 并取提交边界。
 * 失败（头部不合法）返回 error，调用方按「跳过合并」处理。
 */
export function parseWalFrames(
  walPath: string,
  pageSize = PAGE_SIZE
): { ok: true; parsed: ParsedWal } | { ok: false; error: string } {
  if (!existsSync(walPath)) return { ok: false, error: 'WAL 文件不存在' }
  const fd = openSync(walPath, 'r')
  try {
    const size = fstatSync(fd).size
    if (size < WAL_HEADER_SIZE + FRAME_HEADER_SIZE + pageSize) {
      return { ok: false, error: 'WAL 文件过小，忽略' }
    }
    const header = Buffer.alloc(WAL_HEADER_SIZE)
    if (readInto(fd, header, 0) < WAL_HEADER_SIZE) return { ok: false, error: 'WAL 头部读取不完整' }

    const magic = header.readUInt32BE(0)
    if ((magic & 0xfffffffe) !== WAL_MAGIC_BASE) return { ok: false, error: 'WAL 魔数不匹配' }
    const nativeCksum = (magic & 1) === 0
    const walPageSize = header.readUInt32BE(8)
    if (walPageSize !== pageSize) {
      return { ok: false, error: `WAL 页大小 ${walPageSize} 与库页大小 ${pageSize} 不一致` }
    }
    const headerSum = checksumBytes(nativeCksum, header.subarray(0, WAL_HEADER_SIZE - 8), [0, 0])
    if (headerSum[0] !== header.readUInt32BE(24) || headerSum[1] !== header.readUInt32BE(28)) {
      return { ok: false, error: 'WAL 头部校验和不匹配（文件可能正在写入）' }
    }

    const headerSalt = Buffer.from(header.subarray(16, 24))
    const frameSize = FRAME_HEADER_SIZE + pageSize
    const maxFrames = Math.floor((size - WAL_HEADER_SIZE) / frameSize)
    const firstFrame = Buffer.alloc(FRAME_HEADER_SIZE)
    if (readInto(fd, firstFrame, WAL_HEADER_SIZE) < FRAME_HEADER_SIZE) {
      return { ok: true, parsed: EMPTY_WAL('WAL 中没有完整帧') }
    }
    if (!headerSalt.equals(firstFrame.subarray(8, 16))) {
      // 微信实测的常态：checkpoint 后 WAL 重启（salt1+1、mxFrame=0），当前日志为空，主库已是最新
      return { ok: true, parsed: EMPTY_WAL('WAL 当前日志为空（已 checkpoint，主库为最新）') }
    }

    const frames: WalFrame[] = []
    let sum = headerSum
    let lastCommit = 0
    let finalPages = 0
    const frameHeader = Buffer.alloc(FRAME_HEADER_SIZE)
    const page = Buffer.alloc(pageSize)

    for (let index = 1; index <= maxFrames; index += 1) {
      const offset = WAL_HEADER_SIZE + (index - 1) * frameSize
      if (readInto(fd, frameHeader, offset) < FRAME_HEADER_SIZE) break
      if (readInto(fd, page, offset + FRAME_HEADER_SIZE) < pageSize) break
      if (!headerSalt.equals(frameHeader.subarray(8, 16))) break // 世代边界：其后是残留
      const pgno = frameHeader.readUInt32BE(0)
      const nTruncate = frameHeader.readUInt32BE(4)
      if (pgno === 0 || pgno > 0x40000000) break
      // 当前日志内才有效的 checksum 链：初值 = 头部校验和，逐帧滚动
      const afterHeader = checksumBytes(nativeCksum, frameHeader.subarray(0, 8), sum)
      const afterData = checksumBytes(nativeCksum, page, afterHeader)
      if (
        afterData[0] !== frameHeader.readUInt32BE(16) ||
        afterData[1] !== frameHeader.readUInt32BE(20)
      ) {
        break // 撕裂帧：其后帧一律不采信
      }
      sum = afterData
      frames.push({ index, pgno, nTruncate })
      if (nTruncate > 0) {
        lastCommit = index
        finalPages = nTruncate
      }
    }

    return {
      ok: true,
      parsed: {
        current: true,
        frames,
        lastCommit,
        finalPages,
        reason: lastCommit === 0 ? '当前日志没有提交帧（未提交事务）' : undefined
      }
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    closeSync(fd)
  }
}

/** 把「当前日志」中已提交的帧解密写回明文库，并按 nTruncate 截断（随机写，不载入整库） */
export function applyWalToPlainFile(
  walPath: string,
  plainPath: string,
  encryptionKey: Buffer,
  parsed: ParsedWal,
  pageSize = PAGE_SIZE
): { appliedFrames: number; finalPages: number } {
  if (!parsed.current || parsed.lastCommit === 0 || parsed.frames.length === 0) {
    return { appliedFrames: 0, finalPages: parsed.finalPages }
  }
  const walFd = openSync(walPath, 'r')
  const dbFd = openSync(plainPath, 'r+')
  try {
    const frameSize = FRAME_HEADER_SIZE + pageSize
    const page = Buffer.alloc(pageSize)
    let applied = 0
    for (const frame of parsed.frames) {
      if (frame.index > parsed.lastCommit) break
      const offset = WAL_HEADER_SIZE + (frame.index - 1) * frameSize
      readInto(walFd, page, offset + FRAME_HEADER_SIZE)
      const plain = decryptPage(page, encryptionKey, frame.pgno)
      writeSync(dbFd, plain, 0, plain.length, (frame.pgno - 1) * pageSize)
      applied += 1
    }
    if (parsed.finalPages > 0) truncateSync(plainPath, parsed.finalPages * pageSize)
    return { appliedFrames: applied, finalPages: parsed.finalPages }
  } finally {
    closeSync(dbFd)
    closeSync(walFd)
  }
}

/** 便捷入口：解析 + 合并；任何异常都降级为「不合并」，绝不抛给主路径 */
export function mergeWalIntoPlainFile(
  walPath: string,
  plainPath: string,
  encryptionKey: Buffer
): WalSummary {
  const parsed = parseWalFrames(walPath)
  if (!parsed.ok) {
    return {
      framesValid: 0,
      lastCommitFrame: 0,
      appliedFrames: 0,
      finalPages: 0,
      merged: false,
      warning: parsed.error
    }
  }
  const p = parsed.parsed
  if (!p.current || p.frames.length === 0) {
    return {
      framesValid: 0,
      lastCommitFrame: 0,
      appliedFrames: 0,
      finalPages: 0,
      merged: false,
      warning: p.reason
    }
  }
  try {
    const applied = applyWalToPlainFile(walPath, plainPath, encryptionKey, p)
    return {
      framesValid: p.frames.length,
      lastCommitFrame: p.lastCommit,
      appliedFrames: applied.appliedFrames,
      finalPages: applied.finalPages,
      merged: applied.appliedFrames > 0,
      warning: p.lastCommit === 0 ? (p.reason ?? '当前日志未提交') : undefined
    }
  } catch (e) {
    return {
      framesValid: p.frames.length,
      lastCommitFrame: p.lastCommit,
      appliedFrames: 0,
      finalPages: p.finalPages,
      merged: false,
      warning: e instanceof Error ? e.message : String(e)
    }
  }
}
