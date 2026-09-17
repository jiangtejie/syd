/**
 * 「该盯哪些库文件」的纯判定（零依赖，可离线自检）。
 *
 * 背景：微信运行时主要往 **WAL** 追加，主库 mtime 常常不动（要等 checkpoint）；
 * 而明文副本的新鲜度判定`decrypt.ts:sourceSignature`**已经把 WAL 算进去了**。
 * 两处口径不一致的后果是必然二选一：要么界面上的新消息要等到下一次 checkpoint（约 1.5 分钟）
 * 才刷新，要么每次刷新都整库重解。这个模块把监控侧口径对齐到「WAL 也算变化」。
 *
 * 对外的 changedFiles 契约不变：出现的永远是**库文件本身**，不会冒出 -wal 路径
 * （下游按路径判 sessionChanged、按文件触发读库，混进 -wal 会全部失配）。
 */

export const WAL_SUFFIX = '-wal'
/** -shm 只在进程间共享索引，不承载数据变更：只用于归一化，不主动监听 */
export const SHM_SUFFIX = '-shm'

const norm = (s: string): string => s.replace(/\\/g, '/').toLowerCase()

/** 附属文件（-wal / -shm）→ 它所属的库文件；本身不是附属文件时返回 null */
export function logicalDbFileOf(file: string, logicalFiles: string[]): string | null {
  const target = norm(file)
  for (const f of logicalFiles) {
    const base = norm(f)
    if (base === target) return f
    if (base + WAL_SUFFIX === target || base + SHM_SUFFIX === target) return f
  }
  return null
}

/** 是否是某个库文件的 WAL（决定要不要按「WAL 冷却」节流） */
export function isWalOf(file: string, logicalFiles: string[]): boolean {
  const target = norm(file)
  return logicalFiles.some((f) => norm(f) + WAL_SUFFIX === target)
}

/**
 * 实际要盯的文件：库文件 + 各自的 -wal。
 * 不存在的 -wal 也列进来：它出现时（微信首次写入）要能立刻被当成一次变化。
 */
export function watchedDbFiles(logicalFiles: string[]): string[] {
  const out: string[] = []
  for (const f of logicalFiles) {
    out.push(f, f + WAL_SUFFIX)
  }
  return out
}

export interface FileStampLike {
  mtimeMs: number
  size: number
}

/**
 * 明文副本能不能**只按 WAL 增量刷新**（而不是整库重解）。
 *
 * 判据刻意保守，任何一条不成立就返回 false（调用方回落到整库重解，与升级前一致）：
 * - 副本必须存在且非空；
 * - 副本不能比主库小（主库长过说明 checkpoint 写过页）；
 * - **副本 mtime 不能早于主库 mtime** —— 主库自己动过就说明页数据变了，
 *   此时只合 WAL 会把主库的新内容漏掉，必须整库重解。
 * 只有「主库没动、WAL 又长了一截」这一种情形才走增量，那正是微信运行时的常态。
 */
export function shouldRefreshFromWal(
  main: FileStampLike | null,
  plain: FileStampLike | null
): boolean {
  if (!main || !plain || plain.size === 0) return false
  if (plain.size < main.size) return false
  if (plain.mtimeMs < main.mtimeMs) return false
  return true
}
