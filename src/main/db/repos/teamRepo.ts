import { getDb } from '../database'
import type { TeamMemberInfo } from '../../../shared/types'

/**
 * team_member（团队客服成员）持久化。
 * 「全局标识」= 按微信账号作用域记录的联系人 username，跨群生效：
 * 分析/建议引擎把其消息视同己方（我方同事），发送人展示带客服标记。
 */

interface TeamRow {
  account_wxid: string
  username: string
  label: string
  created_at: number
}

export function listTeamMembers(accountWxid: string): TeamMemberInfo[] {
  const rows = getDb()
    .prepare(
      `SELECT username, label FROM team_member WHERE account_wxid = ? ORDER BY created_at ASC`
    )
    .all(accountWxid) as Array<Pick<TeamRow, 'username' | 'label'>>
  return rows.map((r) => ({ username: r.username, label: r.label || '' }))
}

/** 成员 username 集合（供分析器/消息 enrich 快速判定） */
export function listTeamUsernames(accountWxid: string): Set<string> {
  return new Set(listTeamMembers(accountWxid).map((m) => m.username))
}

/** 进程级缓存（数据量小且变更低频；IPC 变更时调用 invalidate） */
let cache: { key: string; at: number; set: Set<string> } | null = null
const TEAM_CACHE_TTL_MS = 10_000

export function getTeamUsernamesCached(accountWxid: string): Set<string> {
  if (cache && cache.key === accountWxid && Date.now() - cache.at < TEAM_CACHE_TTL_MS) {
    return cache.set
  }
  const set = listTeamUsernames(accountWxid)
  cache = { key: accountWxid, at: Date.now(), set }
  return set
}

export function invalidateTeamCache(): void {
  cache = null
}

export function saveTeamMember(
  accountWxid: string,
  username: string,
  label = ''
): TeamMemberInfo {
  const u = (username || '').trim()
  if (!u || !accountWxid) throw new Error('缺少账号或联系人标识')
  const l = (label || '').trim()
  getDb()
    .prepare(
      `INSERT INTO team_member (account_wxid, username, label, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(account_wxid, username) DO UPDATE SET label = excluded.label`
    )
    .run(accountWxid, u, l, Date.now())
  invalidateTeamCache()
  return { username: u, label: l }
}

export function removeTeamMember(accountWxid: string, username: string): boolean {
  const u = (username || '').trim()
  const info = getDb()
    .prepare(`DELETE FROM team_member WHERE account_wxid = ? AND username = ?`)
    .run(accountWxid, u)
  invalidateTeamCache()
  return info.changes > 0
}
