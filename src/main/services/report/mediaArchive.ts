import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import type { Client } from 'pg'
import { decryptImage, decryptVideo } from '../media/mediaService'
import { getMediaCacheDir } from '../paths'
import { createLogger } from '../logging'
import type { ChatMessage } from '../../../shared/types'

/**
 * 上报媒体归档(与聊天渲染共用缓存目录,数据对齐到 <cache>/media/<账号>/):
 * - 图片/视频/文件消息归档到缓存目录(<cacheRoot>/media/<账号>/),PG media_path 存
 *   相对缓存根的地址 media/<账号>/<文件>(正斜杠);读取方用缓存目录拼接即得真实文件;
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

export function sanitizeName(s: string): string {
  return s.replace(/[\\/:*?"<>|\r\n\t]/g, '_').slice(0, 180) || 'file'
}

/** media_path 值:相对缓存根的地址 media/<账号>/<文件>(文件在 <cache>/media/<账号>/ 下同名) */
export function mediaValue(accountWxid: string, fileAbs: string): string {
  return `media/${accountWxid}/${basename(fileAbs)}`
}

/** 归档根:<cacheRoot>/media/<账号>(与聊天媒体缓存同目录,数据对齐) */
function archiveRoot(accountWxid: string): string {
  return getMediaCacheDir(accountWxid)
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

/** 把 src 复制进归档根(缓存 media/<账号>,扁平;幂等已存在即跳过),返回文件绝对路径 */
function archiveInto(root: string, fileName: string, src: string): string | null {
  try {
    if (!existsSync(src)) return null
    mkdirSync(root, { recursive: true })
    const dest = join(root, sanitizeName(fileName))
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
  return sanitizeName(original || basename(src))
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
          const fileName = decodeURIComponent(res.url.split('/').pop() ?? '')
          src = join(getMediaCacheDir(opts.accountWxid), basename(fileName))
          destName = basename(fileName)
        }
      } else if (j.kind === 'video') {
        const res = await decryptVideo({
          wxid: opts.accountWxid,
          videoMd5: j.md5!,
          dbPath: opts.dbPath
        })
        if (res.ok && res.url) {
          const fileName = decodeURIComponent(res.url.split('/').pop() ?? '')
          src = join(getMediaCacheDir(opts.accountWxid), basename(fileName))
          destName = basename(fileName)
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
          const fileName = decodeURIComponent(res.url.split('/').pop() ?? '')
          src = join(getMediaCacheDir(opts.accountWxid), basename(fileName))
          destName = basename(fileName)
        }
      } else if (r.msg_type === '视频消息' && /^[0-9a-f]{32}$/.test(md5)) {
        const res = await decryptVideo({
          wxid: opts.accountWxid,
          videoMd5: md5,
          dbPath: opts.dbPath
        })
        if (res.ok && res.url) {
          const fileName = decodeURIComponent(res.url.split('/').pop() ?? '')
          src = join(getMediaCacheDir(opts.accountWxid), basename(fileName))
          destName = basename(fileName)
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
