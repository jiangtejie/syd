import { getDb } from '../database'
import type { CustomToolInput, CustomToolItem } from '../../../shared/types'

/** ai_custom_tool(自定义 HTTP 工具)持久化。 */

interface ToolRow {
  id: number
  name: string
  label: string
  description: string
  method: string
  url: string
  headers: string
  params: string
  timeout_sec: number
  confirm: number
  enabled: number
  created_at: number
  updated_at: number
}

function parseJson<T>(raw: string, fb: T): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    return fb
  }
}

function rowToTool(r: ToolRow): CustomToolItem {
  return {
    id: r.id,
    name: r.name,
    label: r.label || undefined,
    description: r.description,
    method: r.method,
    url: r.url,
    headers: parseJson<Record<string, string>>(r.headers, {}),
    params: parseJson<CustomToolItem['params']>(r.params, []),
    timeoutSec: r.timeout_sec,
    confirm: r.confirm === 1,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

const TOOL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,40}$/

export function listCustomTools(): CustomToolItem[] {
  const rows = getDb()
    .prepare(`SELECT * FROM ai_custom_tool ORDER BY updated_at DESC`)
    .all() as ToolRow[]
  return rows.map(rowToTool)
}

export function saveCustomTool(input: CustomToolInput): {
  ok: boolean
  error?: string
  item?: CustomToolItem
} {
  const name = (input.name || '').trim()
  const description = (input.description || '').trim()
  const url = (input.url || '').trim()
  if (!TOOL_NAME_RE.test(name)) {
    return { ok: false, error: '工具标识需为字母开头、仅含字母数字下划线(≤40)' }
  }
  if (!description) return { ok: false, error: '请填写工具描述(给模型看)' }
  if (!url) return { ok: false, error: '请填写请求 URL' }
  const method = String(input.method || 'GET').toUpperCase()
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    return { ok: false, error: '不支持的方法' }
  }
  const db = getDb()
  const dup = db
    .prepare(`SELECT id FROM ai_custom_tool WHERE name = ? AND (? IS NULL OR id != ?) LIMIT 1`)
    .get(name, input.id ?? null, input.id ?? null) as { id: number } | undefined
  if (dup) return { ok: false, error: `工具名 ${name} 已存在` }
  // 非只读方法强制人工确认(防模型/用户误触发写操作)
  const isRead = method === 'GET' || method === 'HEAD'
  const confirm = isRead ? input.confirm !== false : true
  const timeout = Math.min(Math.max(Math.floor(input.timeoutSec ?? 20), 3), 120)
  const now = Date.now()
  if (input.id) {
    const info = db
      .prepare(
        `UPDATE ai_custom_tool SET name=?, label=?, description=?, method=?, url=?, headers=?,
           params=?, timeout_sec=?, confirm=?, enabled=?, updated_at=? WHERE id=?`
      )
      .run(
        name,
        (input.label ?? '').trim(),
        description,
        method,
        url,
        JSON.stringify(input.headers ?? {}),
        JSON.stringify(input.params ?? []),
        timeout,
        confirm ? 1 : 0,
        input.enabled === false ? 0 : 1,
        now,
        input.id
      )
    if (info.changes === 0) return { ok: false, error: '工具不存在' }
  } else {
    db.prepare(
      `INSERT INTO ai_custom_tool (name, label, description, method, url, headers, params, timeout_sec, confirm, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      name,
      (input.label ?? '').trim(),
      description,
      method,
      url,
      JSON.stringify(input.headers ?? {}),
      JSON.stringify(input.params ?? []),
      timeout,
      confirm ? 1 : 0,
      input.enabled === false ? 0 : 1,
      now,
      now
    )
  }
  const rows = db
    .prepare(`SELECT * FROM ai_custom_tool WHERE name = ? ORDER BY id DESC LIMIT 1`)
    .all(name) as ToolRow[]
  return rows.length > 0 ? { ok: true, item: rowToTool(rows[0]) } : { ok: false, error: '保存失败' }
}

export function removeCustomTool(id: number): boolean {
  const info = getDb().prepare(`DELETE FROM ai_custom_tool WHERE id = ?`).run(id)
  return info.changes > 0
}
