/**
 * 媒体缓存淘汰策略（纯函数，零 IO，可离线自检）。
 *
 * 背景：`<cache>/media/<账号>/` 里混着三类东西，**只有一类可以删**：
 * - 图片/视频/表情解密产物（`<md5>_orig|thumb|hd|video|emoji.<ext>`）：可再生，删了下次按需重解；
 * - 早期版本的遗留命名（`<md5>.<ext>`）：现在代码只按 `<md5>_<kind>` 查找，这类文件**永远不会再被读到**，
 *   属于纯占地，按同样的年龄规则回收；
 * - 上报归档（`<md5>_file.<ext>`、无 md5 时安全化的原始文件名）：**不能删** —— PG 的 media_path 指着它，
 *   删掉等于让用户下游的数据缺文件（归档已挪到 `archive/` 子目录，这里再兜一层：不认识的命名一律不动）。
 *
 * 淘汰顺序：先按年龄（> keepDays），仍超容量再按最旧削（容量是硬上限，年龄是软上限）。
 */

/** 图片/视频/表情解密产物命名 */
const ASSET_RE = /^[0-9a-f]{32}_(orig|thumb|hd|video|emoji)\.[a-z0-9]{2,5}$/i
/** 早期版本的命名：只有 md5，没有 _kind（现在不再被查找） */
const LEGACY_RE = /^[0-9a-f]{32}\.[a-z0-9]{2,5}$/i

export type MediaCacheKind =
  /** 可再生：解密产物 */
  | 'asset'
  /** 可再生：遗留命名（已无人读取） */
  | 'legacy'
  /** 不可删：上报归档 */
  | 'archive'
  /** 不认识：一律不动 */
  | 'other'

/** 按文件名判断类别（只看名字，不看内容/扩展名白名单之外的东西） */
export function classifyMediaCacheFile(name: string): MediaCacheKind {
  const n = (name || '').trim()
  if (!n) return 'other'
  if (/_file\.[^.]+$/i.test(n)) return 'archive'
  if (LEGACY_RE.test(n) || ASSET_RE.test(n)) return ASSET_RE.test(n) ? 'asset' : 'legacy'
  return 'other'
}

export interface MediaCacheEntry {
  name: string
  size: number
  mtimeMs: number
}

export interface MediaPruneOptions {
  /** 保留天数（软上限）：早于它的可再生文件直接回收 */
  keepDays: number
  /** 容量硬上限（字节）；<=0 表示不限制 */
  maxBytes: number
  /** 文件数硬上限；<=0 表示不限制 */
  maxFiles: number
  now?: number
}

export interface MediaPrunePlan {
  /** 建议删除的文件名 */
  remove: string[]
  /** 回收字节数 */
  freedBytes: number
  /** 受策略保护、未参与淘汰的文件数（归档/不认识） */
  keptProtected: number
  /** 因超容量被削掉的文件数（年龄之外的部分） */
  trimmedBySize: number
}

/**
 * 生成淘汰方案。调用方负责真正删除（Windows 上被占用的文件删除会失败，下轮再试）。
 * 受保护类别（archive/other）既不参与年龄淘汰，也不计入容量统计的「可回收」部分。
 */
export function planMediaPrune(
  entries: MediaCacheEntry[],
  opts: MediaPruneOptions
): MediaPrunePlan {
  const now = opts.now ?? Date.now()
  const cutoff = now - Math.max(0, opts.keepDays) * 24 * 3600_000
  const candidates: MediaCacheEntry[] = []
  let keptProtected = 0

  for (const e of entries) {
    const kind = classifyMediaCacheFile(e.name)
    if (kind === 'asset' || kind === 'legacy') candidates.push(e)
    else keptProtected += 1
  }

  const remove = new Set<string>()
  let freedBytes = 0
  const take = (e: MediaCacheEntry): void => {
    remove.add(e.name)
    freedBytes += e.size
  }

  // 1) 年龄：早于 cutoff 的可再生文件直接回收
  const remain: MediaCacheEntry[] = []
  for (const e of candidates) {
    if (opts.keepDays > 0 && e.mtimeMs < cutoff) take(e)
    else remain.push(e)
  }

  // 2) 容量：仍超上限就按最旧削（年龄是软上限，容量是硬上限）
  //    注意：上限只算「可回收的那部分」—— 归档是用户数据，既不能删、也不能占着额度把缓存挤爆
  //    （否则 archive 一大，每次清理都会把所有可再生文件删光）。
  let liveBytes = remain.reduce((sum, e) => sum + e.size, 0)
  let liveFiles = remain.length
  let trimmedBySize = 0
  remain.sort((a, b) => a.mtimeMs - b.mtimeMs)
  for (const e of remain) {
    const overBytes = opts.maxBytes > 0 && liveBytes > opts.maxBytes
    const overFiles = opts.maxFiles > 0 && liveFiles > opts.maxFiles
    if (!overBytes && !overFiles) break
    take(e)
    liveBytes -= e.size
    liveFiles -= 1
    trimmedBySize += 1
  }

  return { remove: [...remove], freedBytes, keptProtected, trimmedBySize }
}
