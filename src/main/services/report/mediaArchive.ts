import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import type { Client } from 'pg'
import { decryptImage, decryptVideo } from '../media/mediaService'
import { safeFileName } from '../_filename'
import { getCachePath, getMediaArchiveDir, getMediaRootDir } from '../paths'
import { createLogger } from '../logging'
import { getConfig, setConfig } from '../../db/repos/config'
import type { ChatMessage } from '../../../shared/types'

/**
 * 上报媒体归档(与聊天渲染共用缓存根,但**目录已分开**):
 * - 归档目录 <cache>/media/<账号>/archive/ —— PG media_path 存 media/<账号>/archive/<文件>(正斜杠);
 * - 为什么要分开:media 根目录里放的是「可再生的展示缓存」(会被保留策略淘汰),
 *   而 media_path 指的是用户自己的数据 —— 以前两者是同一个文件,一次缓存清理就会让下游缺文件;
 * - 命名:图片沿用解密缓存名 <md5>_orig|thumb|hd.<ext>;视频 <md5>_video.<ext>;
 *   文件 <md5>_file.<ext>(无 md5 时用安全化的原始文件名);
 * - media_path 仅当目标为空时写入;语音/表情仅补 md5;单轮限量,失败/缺源留空下轮续。
 */

const mediaLog = createLogger('report')
/** 单文件目录遍历上限 */
const GUARD = 4000
/** 让出事件循环(解密/目录遍历为同步热点) */
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

export interface MediaJob {
  sessionWxid: string
  localId: number
  kind: 'image' | 'video' | 'file'
  /** 图片/视频的 md5(文件消息可空:按原始文件名定位) */
  md5?: string
  fileName?: string
}

/** 消息 → 归档任务(仅归档范围内类型);不匹配返回 null */
export function mediaJobOf(sessionWxid: string, m: ChatMessage): MediaJob | null {
  const t = m.localType
  if (t === 3) {
    const md5 = (m.imageMd5 ?? '').trim()
    return /^[0-9a-f]{32}$/i.test(md5)
      ? { sessionWxid, localId: m.localId, kind: 'image', md5: md5.toLowerCase() }
      : null
  }
  if (t === 43) {
    const md5 = (m.videoMd5 ?? '').trim()
    return /^[0-9a-f]{32}$/i.test(md5)
      ? { sessionWxid, localId: m.localId, kind: 'video', md5: md5.toLowerCase() }
      : null
  }
  if (t === 49 && (m.fileName || m.fileMd5)) {
    return {
      sessionWxid,
      localId: m.localId,
      kind: 'file',
      md5: (m.fileMd5 ?? '').trim() || undefined,
      fileName: (m.fileName ?? '').trim() || undefined
    }
  }
  return null
}

/**
 * media_path 值:相对缓存根的地址 media/<账号>/archive/<文件>。
 * 由绝对路径反推(而不是拼 basename),这样归档目录将来再挪也不会写错路径。
 */
export function mediaValue(accountWxid: string, fileAbs: string): string {
  const root = getMediaRootDir()
  const abs = fileAbs.replace(/\\/g, '/')
  const rootPosix = root.replace(/\\/g, '/').replace(/\/$/, '')
  if (abs.startsWith(rootPosix + '/')) return 'media/' + abs.slice(rootPosix.length + 1)
  // 不在缓存根下(理论上不会发生):退回旧的扁平写法,保证至少不写出绝对路径
  return `media/${accountWxid}/archive/${basename(fileAbs)}`
}

/** 归档根:<cache>/media/<账号>/archive(与可再生的展示缓存分开,见模块注释) */
function archiveRoot(accountWxid: string): string {
  return getMediaArchiveDir(accountWxid)
}

/** 附件根候选:<base>/<wxid>/msg/attach|file|video 或 <base>/msg/… */
function attachRootCandidates(
  basePath: string,
  wxid: string,
  kind: 'file' | 'attach' | 'video'
): string[] {
  const k = kind === 'file' ? 'file' : kind === 'video' ? 'video' : 'attach'
  return [join(basePath, wxid, 'msg', k), join(basePath, 'msg', k)]
}

function findDir(candidates: string[]): string | null {
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isDirectory()) return c
    } catch {
      /* ignore */
    }
  }
  return null
}

/** 深搜第一个匹配文件:文件名 == target 或 去扩展名 == md5 */
function findRawFile(root: string, targetName?: string, md5?: string): string | null {
  const nameLower = (targetName ?? '').toLowerCase()
  const md5Lower = (md5 ?? '').toLowerCase()
  const stack: string[] = [root]
  let guard = 0
  while (stack.length > 0 && guard < GUARD) {
    guard++
    const dir = stack.pop()!
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        stack.push(full)
        continue
      }
      const stem = e.name.replace(/\.[^.]+$/, '').toLowerCase()
      if (e.name.toLowerCase() === nameLower) return full
      if (md5Lower && stem === md5Lower) return full
      if (nameLower && e.name.toLowerCase().startsWith(nameLower)) return full
    }
  }
  return null
}

/**
 * 从 ct-media URL 反解绝对路径（协议布局 <wxid>/<资源名> 或 <wxid>/<子目录>/<文件>）。
 * 导出给飞书证据附件复用：那边也需要「URL → 本地文件」这一步，不该再写第二份。
 */
export function resolveMediaUrl(url: string): { abs: string; name: string } | null {
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean).map(decodeURIComponent)
    if (seg.length < 2) return null
    const abs = join(getMediaRootDir(), ...seg)
    return existsSync(abs) ? { abs, name: seg[seg.length - 1] } : null
  } catch {
    return null
  }
}

/** 把 src 复制进归档根(缓存 media/<账号>,扁平;幂等已存在即跳过),返回文件绝对路径 */
function archiveInto(root: string, fileName: string, src: string): string | null {
  try {
    if (!existsSync(src)) return null
    mkdirSync(root, { recursive: true })
    const dest = join(
      root,
      safeFileName(fileName, { maxLength: 180, fallback: 'file', trim: false, collapse: false })
    )
    if (!existsSync(dest)) {
      try {
        copyFileSync(src, dest)
      } catch {
        return null
      }
    }
    return dest.replace(/\\/g, '/')
  } catch {
    return null
  }
}

/** 文件类归档命名:<md5>_file<ext>(无 md5 回退安全化原始名,保证扁平目录不冲突) */
function fileDestName(md5: string | undefined, src: string, original?: string): string {
  const ext = extname(src) || (original ? extname(original) : '')
  if (md5 && /^[0-9a-f]{32}$/i.test(md5)) return `${md5.toLowerCase()}_file${ext}`
  return safeFileName(original || basename(src), {
    maxLength: 180,
    fallback: 'file',
    trim: false,
    collapse: false
  })
}

/** 写 PG(仅空时补,不覆盖已有路径);返回是否写入 */
async function writePathIfEmpty(
  client: Client,
  schema: string,
  sessionWxid: string,
  localId: number,
  path: string
): Promise<boolean> {
  const q = quoteIdent(schema)
  const r = await client.query(
    `UPDATE ${q}.messages SET media_path = $1
     WHERE session_wxid = $2 AND local_id = $3 AND (media_path IS NULL OR media_path = '')`,
    [path, sessionWxid, localId]
  )
  return (r.rowCount ?? 0) > 0
}

function quoteIdent(s: string): string {
  return `"${s.replace(/"/g, '""')}"`
}

export interface ArchiveSummary {
  done: number
  failed: number
  skippedNoSource: number
}

/** 处理一批(扫描中积累的)媒体任务;同轮限流,失败留空下轮续 */
export async function archiveMediaJobs(
  client: Client,
  opts: {
    schema: string
    accountWxid: string
    dbPath: string
  },
  jobs: MediaJob[],
  budget: number,
  signal?: AbortSignal
): Promise<ArchiveSummary> {
  const sum: ArchiveSummary = { done: 0, failed: 0, skippedNoSource: 0 }
  if (jobs.length === 0) return sum
  const root = archiveRoot(opts.accountWxid)
  const effective = jobs.slice(0, budget)
  for (const j of effective) {
    if (signal?.aborted) break
    await tick() // 每项前让出主进程(同步解密/目录遍历较多)
    let src: string | null = null
    let destName = ''
    try {
      if (j.kind === 'image') {
        const res = await decryptImage({
          wxid: opts.accountWxid,
          imageMd5: j.md5!,
          kind: 'orig',
          dbPath: opts.dbPath
        })
        if (res.ok && res.url) {
          const hit = resolveMediaUrl(res.url)
          if (hit) {
            src = hit.abs
            destName = hit.name
          }
        }
      } else if (j.kind === 'video') {
        const res = await decryptVideo({
          wxid: opts.accountWxid,
          videoMd5: j.md5!,
          dbPath: opts.dbPath
        })
        if (res.ok && res.url) {
          const hit = resolveMediaUrl(res.url)
          if (hit) {
            src = hit.abs
            destName = hit.name
          }
        }
      } else {
        // 文件:微信附件目录原始文件(明文),按原始名或 md5 定位
        const rootDir = findDir(attachRootCandidates(opts.dbPath, opts.accountWxid, 'file'))
        if (rootDir) {
          const hit = findRawFile(rootDir, j.fileName, j.md5)
          if (hit) {
            src = hit
            destName = fileDestName(j.md5, hit, j.fileName)
          }
        }
      }
      if (!src) {
        sum.skippedNoSource++
        continue
      }
      const stored = archiveInto(root, destName, src)
      if (!stored) {
        sum.failed++
        continue
      }
      // media_path = 相对缓存根:media/<账号>/<文件>
      await writePathIfEmpty(
        client,
        opts.schema,
        j.sessionWxid,
        j.localId,
        mediaValue(opts.accountWxid, stored)
      )
      sum.done++
    } catch {
      sum.failed++
    }
  }
  if (sum.done > 0 || sum.failed > 0 || sum.skippedNoSource > 0) {
    mediaLog.info(`媒体归档:成功 ${sum.done},缺源 ${sum.skippedNoSource},失败 ${sum.failed}`)
  }
  return sum
}

/**
 * 归档目录迁移（一次性、**非破坏**）：把历史上散落在 media 根的归档复制进 \`archive/\`。
 *
 * - 只处理「确实会被写进 media_path」的命名：\`<md5>_file.<ext>\`（文件归档）与
 *   \`<md5>_orig|thumb|hd|video.<ext>\`（图片/视频归档，旧代码直接沿用展示缓存文件）；
 * - **只复制不删除**：旧 PG 行仍指向旧的扁平路径，继续可读；新行一律写 \`archive/\`；
 *   扁平副本随后由媒体缓存保留策略按年龄回收（默认 180 天，可配置/可关）；
 * - 幂等 + 配置门控：跑完写 \`wechat.report.archiveMigrated=1\`，force 时忽略门控。
 */
export function migrateArchiveLayout(force = false): {
  copied: number
  scanned: number
  accounts: number
} {
  if (!force && getConfig('wechat.report.archiveMigrated') === '1') {
    return { copied: 0, scanned: 0, accounts: 0 }
  }
  const out = { copied: 0, scanned: 0, accounts: 0 }
  const ARCHIVE_SRC_RE = /^[0-9a-f]{32}_(orig|thumb|hd|video|file)\.[a-z0-9]{2,5}$/i
  let root = ''
  try {
    root = getMediaRootDir()
  } catch {
    return out
  }
  let accounts: import('node:fs').Dirent[] = []
  try {
    accounts = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())
  } catch {
    return out
  }
  for (const acc of accounts) {
    const accountDir = join(root, acc.name)
    let names: string[] = []
    try {
      names = readdirSync(accountDir)
    } catch {
      continue
    }
    const pending = names.filter((n) => ARCHIVE_SRC_RE.test(n))
    if (pending.length === 0) continue
    out.accounts++
    const destRoot = getMediaArchiveDir(acc.name)
    for (const name of pending) {
      out.scanned++
      const src = join(accountDir, name)
      const dest = join(destRoot, name)
      if (existsSync(dest)) continue
      try {
        mkdirSync(destRoot, { recursive: true })
        copyFileSync(src, dest)
        out.copied++
      } catch {
        /* 单个失败不影响整体 */
      }
    }
  }
  if (out.copied > 0) {
    mediaLog.info(`归档目录迁移:复制 ${out.copied} 个文件到 archive/（扫描 ${out.scanned} 个）`)
  }
  try {
    setConfig('wechat.report.archiveMigrated', '1')
  } catch {
    /* 写配置失败：下次启动重跑（幂等，代价只是再扫一遍） */
  }
  return out
}

/** 路径修复游标（create_time 升序单调推进，避免每轮重复扫历史） */
const PATH_REPAIR_CURSOR_KEY = 'wechat.report.pathRepairCursor'
/** 单轮最多检查多少行 */
const PATH_REPAIR_BUDGET = 300

interface MediaPathRow {
  session_wxid: string
  local_id: number
  media_path: string
  create_time: number
}

/**
 * 归档路径修复：media_path 仍指向旧的扁平路径、而那个文件已经不在了（被媒体保留策略回收），
 * 但 archive/ 下有同名文件 → 改写为归档路径。
 *
 * 为什么需要：缓存淘汰是新引入的能力，历史上 media_path 与展示缓存是同一个文件；
 * 只修「旧路径缺失 + 归档里有同名文件」这一种情况（本地即可判定），不动用户其它数据。
 */
export async function repairMediaPaths(
  client: Client,
  opts: { schema: string; accountWxid: string },
  budget = PATH_REPAIR_BUDGET
): Promise<{ checked: number; repaired: number; missing: number }> {
  const out = { checked: 0, repaired: 0, missing: 0 }
  if (budget <= 0) return out
  const schemaQ = quoteIdent(opts.schema || 'chat')
  let cursor = 0
  try {
    cursor = Number(getConfig(PATH_REPAIR_CURSOR_KEY) ?? 0) || 0
  } catch {
    /* 配置读不到就从 0 开始 */
  }
  const rows = (
    await client.query(
      `SELECT session_wxid, local_id, media_path, create_time FROM ${schemaQ}.messages
       WHERE media_path IS NOT NULL AND media_path <> '' AND create_time > $1
       ORDER BY create_time ASC LIMIT $2`,
      [cursor, budget]
    )
  ).rows as MediaPathRow[]
  if (rows.length === 0) return out

  const cacheRoot = getCachePath()
  let maxCreate = cursor
  for (const r of rows) {
    out.checked++
    if (r.create_time > maxCreate) maxCreate = r.create_time
    const rel = String(r.media_path || '').replace(/\\/g, '/')
    if (rel.includes('/archive/')) continue
    try {
      if (existsSync(join(cacheRoot, rel))) continue
    } catch {
      continue
    }
    // 旧路径不存在：看归档里有没有同名文件
    const seg = rel.split('/').filter(Boolean) // media/<账号>/<文件>
    const acc = seg.length >= 3 && seg[0] === 'media' ? seg[1] : opts.accountWxid
    const twin = join(getMediaArchiveDir(acc), basename(rel))
    if (!existsSync(twin)) {
      out.missing++
      continue
    }
    const newRel = mediaValue(acc, twin)
    try {
      await client.query(
        `UPDATE ${schemaQ}.messages SET media_path = $1 WHERE session_wxid = $2 AND local_id = $3`,
        [newRel, r.session_wxid, r.local_id]
      )
      out.repaired++
    } catch {
      out.missing++
    }
  }
  try {
    setConfig(PATH_REPAIR_CURSOR_KEY, String(maxCreate))
  } catch {
    /* 游标写失败：下轮重复扫这批（幂等） */
  }
  if (out.repaired > 0 || out.missing > 0) {
    mediaLog.info(`归档路径修复:改写 ${out.repaired},仍缺 ${out.missing}(检查 ${out.checked})`)
  }
  return out
}

export interface MissingMediaRow {
  session_wxid: string
  local_id: number
  media_md5: string
  msg_type: string
}

/** 历史补全:目标库中 media_path 为空且有 md5 的媒体行(限量),按 md5/类型直接归档;文件类缺名则回扫消息定位 */
export async function backfillMissingMedia(
  client: Client,
  opts: {
    schema: string
    accountWxid: string
    dbPath: string
  },
  budget: number,
  listSessionMessages: (
    sessionId: string,
    limit: number,
    before?: { sortSeq: number; createTime: number; localId: number }
  ) => {
    ok: boolean
    messages?: ChatMessage[]
    hasMore?: boolean
    nextCursor?: { sortSeq: number; createTime: number; localId: number }
    error?: string
  }
): Promise<ArchiveSummary> {
  const sum: ArchiveSummary = { done: 0, failed: 0, skippedNoSource: 0 }
  if (budget <= 0) return sum
  const schemaQ = quoteIdent(opts.schema)
  const rows = (
    await client.query(
      `SELECT session_wxid, local_id, media_md5, msg_type FROM ${schemaQ}.messages
       WHERE (media_path IS NULL OR media_path = '') AND media_md5 IS NOT NULL AND media_md5 != ''
       ORDER BY create_time DESC LIMIT $1`,
      [budget]
    )
  ).rows as MissingMediaRow[]
  if (rows.length === 0) return sum
  const root = archiveRoot(opts.accountWxid)
  for (const r of rows) {
    await tick() // 每行前让出主进程
    let destName = ''
    let src: string | null = null
    try {
      const md5 = (r.media_md5 ?? '').toLowerCase()
      if (r.msg_type === '图片消息' && /^[0-9a-f]{32}$/.test(md5)) {
        const res = await decryptImage({
          wxid: opts.accountWxid,
          imageMd5: md5,
          kind: 'orig',
          dbPath: opts.dbPath
        })
        if (res.ok && res.url) {
          const hit = resolveMediaUrl(res.url)
          if (hit) {
            src = hit.abs
            destName = hit.name
          }
        }
      } else if (r.msg_type === '视频消息' && /^[0-9a-f]{32}$/.test(md5)) {
        const res = await decryptVideo({
          wxid: opts.accountWxid,
          videoMd5: md5,
          dbPath: opts.dbPath
        })
        if (res.ok && res.url) {
          const hit = resolveMediaUrl(res.url)
          if (hit) {
            src = hit.abs
            destName = hit.name
          }
        }
      } else if (r.msg_type === '文件消息') {
        // 文件消息无文件名列:回扫该会话最近几页找 local_id 对应的原始名
        let found: ChatMessage | null = null
        let before: { sortSeq: number; createTime: number; localId: number } | undefined
        for (let p = 0; p < 6 && !found; p++) {
          const page = listSessionMessages(r.session_wxid, 500, before)
          if (!page.ok || !page.messages) break
          for (const m of page.messages) {
            if (m.localId === r.local_id && (m.fileName || m.fileMd5)) {
              found = m
              break
            }
          }
          if (found) break
          if (!page.hasMore || !page.nextCursor) break
          before = page.nextCursor
        }
        if (found) {
          const fileRoot = findDir(attachRootCandidates(opts.dbPath, opts.accountWxid, 'file'))
          if (fileRoot) {
            const hit = findRawFile(fileRoot, found.fileName, found.fileMd5)
            if (hit) {
              src = hit
              destName = fileDestName(found.fileMd5, hit, found.fileName)
            }
          }
        }
      }
      if (!src) {
        sum.skippedNoSource++
        continue
      }
      const stored = archiveInto(root, destName, src)
      if (!stored) {
        sum.failed++
        continue
      }
      await writePathIfEmpty(
        client,
        opts.schema,
        r.session_wxid,
        r.local_id,
        mediaValue(opts.accountWxid, stored)
      )
      sum.done++
    } catch {
      sum.failed++
    }
  }
  if (sum.done + sum.failed + sum.skippedNoSource > 0) {
    mediaLog.info(`媒体补全(历史):成功 ${sum.done},缺源 ${sum.skippedNoSource},失败 ${sum.failed}`)
  }
  return sum
}
