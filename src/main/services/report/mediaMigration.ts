import { copyFileSync, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { basename, join, normalize, relative as pathRelative } from 'node:path'
import type { Client } from 'pg'

/**
 * 历史媒体迁移(一次性/可重复执行;主进程 IPC 与运维脚本共用,无 electron 依赖):
 * - 把指向旧归档(chat-sync:项目根 media/<会话>/<文件>,绝对/相对/file:// 形态均可)的 media_path
 *   迁移到当前任务的媒体根目录(默认 %APPDATA%/wechat-cs-desktop/report-media/<账号>,或任务配置的目录),
 *   并把库内地址统一改写为相对地址(<会话>/<文件>,正斜杠);
 * - 已在当前根下但存成绝对地址的行(早期版本写入)原地转相对,不搬文件;
 * - 安全:先拷贝成功并落库成功后才删除旧源(仅限旧归档 media/ 目录内的文件);失败/缺源行保持原样,
 *   重跑自动续传;越界绝对路径(不在旧根也不在新根)保留不动。
 */

export interface MigrateResult {
  scanned: number
  migrated: number
  converted: number
  missingSource: number
  skippedOutside: number
  errors: string[]
}

interface PathRow {
  session_wxid: string
  local_id: number
  media_path: string
}

function sanitizeName(s: string): string {
  return s.replace(/[\\/:*?"<>|\r\n\t]/g, '_').slice(0, 180) || 'file'
}

/** 归档根:显式配置优先;缺省 %APPDATA%/wechat-cs-desktop/report-media/<账号> */
function archiveRoot(mediaDir: string | undefined, accountWxid: string): string {
  const explicit = (mediaDir ?? '').trim()
  if (explicit) return explicit
  return join(
    process.env.APPDATA ?? '',
    'wechat-cs-desktop',
    'report-media',
    sanitizeName(accountWxid)
  )
}

function relToRoot(root: string, abs: string): string {
  return pathRelative(root, abs).replace(/\\/g, '/')
}

function quoteIdent(schema: string): string {
  return `"${schema.replace(/"/g, '""')}"`
}

/** 把 DB 里的地址形态解析成本地路径候选(按先后顺序取第一个存在的文件) */
function localCandidates(p: string, legacyDirs: string[]): string[] {
  const out: string[] = []
  let v = (p ?? '').trim()
  if (!v) return out
  if (v.startsWith('file://')) v = v.slice('file://'.length)
  if (/^\/[A-Za-z]:/.test(v)) v = v.slice(1)
  if (/^[A-Za-z]:[\\/]/.test(v) || v.startsWith('\\\\')) {
    out.push(v)
    return out
  }
  const rest = v.startsWith('media/') || v.startsWith('media\\') ? v.slice('media/'.length) : v
  for (const dir of legacyDirs) {
    out.push(join(dir, 'media', rest))
    if (!v.startsWith('media')) out.push(join(dir, rest))
  }
  return out
}

function isUnder(root: string, file: string): boolean {
  const r = normalize(root).toLowerCase()
  const f = normalize(file).toLowerCase()
  return f === r || f.startsWith(r + '\\') || f.startsWith(r + '/')
}

function note(m: string): void {
  // 应用内走统一日志通道;独立运维执行时打印到控制台
  console.log(`[migrate-media] ${m}`)
}

/** 执行迁移;mediaDir 为空时使用默认根。dryRun=true 只统计不改写。 */
export async function migrateLegacyMediaPaths(
  client: Client,
  schema: string,
  opts: {
    accountWxid: string
    mediaDir?: string
    /** 旧归档项目根(chat-sync 目录等,其下 media/<会话>/<文件>) */
    legacyDirs: string[]
    dryRun?: boolean
  }
): Promise<MigrateResult> {
  const res: MigrateResult = {
    scanned: 0,
    migrated: 0,
    converted: 0,
    missingSource: 0,
    skippedOutside: 0,
    errors: []
  }
  const root = archiveRoot(opts.mediaDir, opts.accountWxid)
  const q = quoteIdent(schema)
  const rows = (
    await client.query(
      `SELECT session_wxid, local_id, media_path FROM ${q}.messages WHERE media_path IS NOT NULL AND media_path != ''`
    )
  ).rows as PathRow[]
  res.scanned = rows.length
  note(`扫描 ${rows.length} 行,目标根=${root}`)

  for (const r of rows) {
    const oldVal = (r.media_path ?? '').trim()
    const isAbs = /^[A-Za-z]:[\\/]/.test(oldVal) || oldVal.startsWith('\\\\')
    if (!isAbs && !oldVal.startsWith('media/') && !oldVal.startsWith('media\\')) {
      // 已是规范相对地址(<会话>/<文件>):无需处理
      continue
    }
    const cands = localCandidates(oldVal, opts.legacyDirs)
    const src = cands.find((c) => existsSync(c) && statSync(c).isFile()) ?? null
    if (!src) {
      if (isAbs) {
        const norm = normalize(oldVal.replace(/\//g, '\\'))
        if (isUnder(root, norm)) {
          const rel = relToRoot(root, norm)
          if (!opts.dryRun) {
            await client.query(
              `UPDATE ${q}.messages SET media_path = $1 WHERE session_wxid = $2 AND local_id = $3`,
              [rel, r.session_wxid, r.local_id]
            )
          }
          res.converted++
        } else {
          res.skippedOutside++
        }
      } else {
        // 相对形态:media/<会话>/<文件>
        const tail =
          oldVal.startsWith('media/') || oldVal.startsWith('media\\')
            ? oldVal.slice('media/'.length)
            : oldVal
        const under = join(root, tail.replace(/\\/g, '/'))
        if (existsSync(under) && statSync(under).isFile()) {
          // 已在新根(幂等重跑/早期手工迁移):归正为规范相对地址
          const rel = relToRoot(root, under)
          if (rel !== oldVal && !opts.dryRun) {
            await client.query(
              `UPDATE ${q}.messages SET media_path = $1 WHERE session_wxid = $2 AND local_id = $3`,
              [rel, r.session_wxid, r.local_id]
            )
          }
          res.converted++
        } else {
          res.missingSource++
        }
      }
      continue
    }
    const dest = join(root, sanitizeName(r.session_wxid), basename(src))
    const rel = relToRoot(root, dest)
    if (!opts.dryRun) {
      try {
        if (!existsSync(dest)) {
          mkdirSync(join(root, sanitizeName(r.session_wxid)), { recursive: true })
          copyFileSync(src, dest)
        }
        // 落库(带旧值守卫,防并发覆盖)
        const up = await client.query(
          `UPDATE ${q}.messages SET media_path = $1 WHERE session_wxid = $2 AND local_id = $3 AND media_path = $4`,
          [rel, r.session_wxid, r.local_id, oldVal]
        )
        if ((up.rowCount ?? 0) === 0) {
          res.errors.push(`${r.session_wxid}/${r.local_id}: 行已被其他进程更新,跳过`)
          continue
        }
        // 删除旧源:仅限旧归档目录 media/ 之内
        for (const dir of opts.legacyDirs) {
          if (isUnder(join(dir, 'media'), src)) {
            try {
              unlinkSync(src)
            } catch {
              /* 已删/占用忽略 */
            }
            break
          }
        }
      } catch (e) {
        res.errors.push(`${r.session_wxid}/${r.local_id}: ${e instanceof Error ? e.message : e}`)
        continue
      }
    }
    res.migrated++
  }
  if (!opts.dryRun) {
    note(
      `完成:迁移 ${res.migrated},原地转相对 ${res.converted},缺源 ${res.missingSource},越界保留 ${res.skippedOutside},失败 ${res.errors.length}`
    )
  }
  return res
}
