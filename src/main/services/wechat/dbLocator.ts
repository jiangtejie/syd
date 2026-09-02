import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

/**
 * 微信数据库文件定位（自研实现，参考微信数据目录形态）。
 *
 * 目录形态兼容：
 *   - <root>/db_storage
 *   - <root>/<wxid>/db_storage
 *   - <root>/<wxid>_xxxx/db_storage
 */

export interface WeChatDbPaths {
  /** db_storage 根目录 */
  dbStoragePath: string | null
  /** 消息库文件（msg_*.db / message_*.db） */
  msgDbFiles: string[]
  /** session 库（会话表所在），可能不存在 */
  sessionDbFile: string | null
}

/** 从用户填写的微信数据根目录解析 db_storage 实际路径 */
export function resolveDbStoragePath(dbPath: string, wxid: string): string | null {
  if (!dbPath) return null
  const normalized = dbPath.replace(/[\\/]+$/, '')
  if (basename(normalized).toLowerCase() === 'db_storage' && existsSync(normalized)) return normalized

  const direct = join(normalized, 'db_storage')
  if (existsSync(direct)) return direct

  if (wxid) {
    const viaWxid = join(normalized, wxid, 'db_storage')
    if (existsSync(viaWxid)) return viaWxid
    try {
      const lowerWxid = wxid.toLowerCase()
      for (const entry of readdirSync(normalized)) {
        const entryPath = join(normalized, entry)
        try {
          if (!statSync(entryPath).isDirectory()) continue
        } catch {
          continue
        }
        const lowerEntry = entry.toLowerCase()
        if (lowerEntry !== lowerWxid && !lowerEntry.startsWith(`${lowerWxid}_`)) continue
        const candidate = join(entryPath, 'db_storage')
        if (existsSync(candidate)) return candidate
      }
    } catch {
      /* ignore */
    }
  }
  return null
}

/** 扫描 db_storage 下所有消息库文件（递归，限制深度防失控） */
export function findMsgDbFiles(dbStoragePath: string, depth = 0): string[] {
  const results: string[] = []
  if (depth > 4) return results
  let entries: string[]
  try {
    entries = readdirSync(dbStoragePath)
  } catch {
    return results
  }
  for (const entry of entries) {
    const full = join(dbStoragePath, entry)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isFile()) {
      const lower = entry.toLowerCase()
      if ((lower.startsWith('msg_') || lower.startsWith('message_')) && lower.endsWith('.db')) {
        if (!results.includes(full)) results.push(full)
      }
    } else if (st.isDirectory()) {
      results.push(...findMsgDbFiles(full, depth + 1))
    }
  }
  return results
}

/** 在 db_storage 下定位 session.db（加权选择最可能的路径） */
export function findSessionDbFile(dbStoragePath: string): string | null {
  const candidates: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 5) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry)
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isFile() && entry.toLowerCase() === 'session.db') {
        candidates.push(full)
      } else if (st.isDirectory()) {
        walk(full, depth + 1)
      }
    }
  }
  walk(dbStoragePath, 0)

  const score = (p: string): number => {
    const normalized = p.replace(/\\/g, '/').toLowerCase()
    let s = 0
    if (normalized.endsWith('/session/session.db')) s += 40
    if (normalized.includes('/db_storage/session/')) s += 20
    if (normalized.includes('/db_storage/')) s += 10
    return s
  }
  if (candidates.length === 0) return null
  return candidates.sort((a, b) => score(b) - score(a) || a.localeCompare(b))[0]
}

/** 汇总一次完整的库定位 */
export function locateWeChatDbs(dbPath: string, wxid: string): WeChatDbPaths {
  const dbStoragePath = resolveDbStoragePath(dbPath, wxid)
  if (!dbStoragePath) {
    return { dbStoragePath: null, msgDbFiles: [], sessionDbFile: null }
  }
  return {
    dbStoragePath,
    msgDbFiles: findMsgDbFiles(dbStoragePath),
    sessionDbFile: findSessionDbFile(dbStoragePath)
  }
}
