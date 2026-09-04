import { getDb } from '../database'
import type { McpServerInput, McpServerItem } from '../../../shared/types'

/** ai_mcp_server 持久化。 */

interface McpRow {
  id: number
  name: string
  kind: string
  command: string
  args: string
  url: string
  timeout_sec: number
  confirm: number
  enabled: number
  created_at: number
  updated_at: number
}

function parseArgs(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  } catch {
    /* ignore */
  }
  return []
}

function rowToServer(r: McpRow): McpServerItem {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind === 'http' ? 'http' : 'stdio',
    command: r.command || undefined,
    args: parseArgs(r.args),
    url: r.url || undefined,
    timeoutSec: r.timeout_sec,
    confirm: r.confirm === 1,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

export function listMcpServers(): McpServerItem[] {
  const rows = getDb()
    .prepare(`SELECT * FROM ai_mcp_server ORDER BY created_at ASC`)
    .all() as McpRow[]
  return rows.map(rowToServer)
}

export function saveMcpServer(input: McpServerInput): {
  ok: boolean
  error?: string
  item?: McpServerItem
} {
  const name = (input.name || '').trim()
  const kind = input.kind === 'http' ? 'http' : 'stdio'
  if (!name) return { ok: false, error: '请填写服务器名称' }
  if (kind === 'stdio' && !(input.command || '').trim()) {
    return { ok: false, error: 'stdio 服务器需要填写启动命令' }
  }
  if (kind === 'http' && !(input.url || '').trim()) {
    return { ok: false, error: 'http 服务器需要填写 URL' }
  }
  const db = getDb()
  const now = Date.now()
  const timeout = Math.min(Math.max(Math.floor(input.timeoutSec ?? 30), 5), 300)
  const argsJson = JSON.stringify((input.args ?? []).filter((x) => typeof x === 'string'))
  const confirm = input.confirm === false ? 0 : 1
  const enabled = input.enabled === true ? 1 : 0
  if (input.id) {
    const info = db
      .prepare(
        `UPDATE ai_mcp_server SET name = ?, kind = ?, command = ?, args = ?, url = ?,
           timeout_sec = ?, confirm = ?, enabled = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        name,
        kind,
        (input.command ?? '').trim(),
        argsJson,
        (input.url ?? '').trim(),
        timeout,
        confirm,
        enabled,
        now,
        input.id
      )
    if (info.changes === 0) return { ok: false, error: '服务器不存在' }
  } else {
    db.prepare(
      `INSERT INTO ai_mcp_server (name, kind, command, args, url, timeout_sec, confirm, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      name,
      kind,
      (input.command ?? '').trim(),
      argsJson,
      (input.url ?? '').trim(),
      timeout,
      confirm,
      enabled,
      now,
      now
    )
  }
  const rows = db
    .prepare(`SELECT * FROM ai_mcp_server WHERE name = ? ORDER BY id DESC LIMIT 1`)
    .all(name) as McpRow[]
  return rows.length > 0
    ? { ok: true, item: rowToServer(rows[0]) }
    : { ok: false, error: '保存失败' }
}

export function removeMcpServer(id: number): boolean {
  const info = getDb().prepare(`DELETE FROM ai_mcp_server WHERE id = ?`).run(id)
  return info.changes > 0
}
