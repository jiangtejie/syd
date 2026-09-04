import { getDb } from '../database'
import type { AgentMemoryInput, AgentMemoryItem } from '../../../shared/types'

/** agent_memory(常驻记忆条目)持久化;agent_id 空 = 全部智能体生效。 */

interface MemoryRow {
  id: number
  agent_id: string | null
  content: string
  enabled: number
  created_at: number
  updated_at: number
}

function rowToItem(r: MemoryRow): AgentMemoryItem {
  return {
    id: r.id,
    agentId: r.agent_id ?? undefined,
    content: r.content,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

export function listMemories(): AgentMemoryItem[] {
  const rows = getDb()
    .prepare(`SELECT * FROM agent_memory ORDER BY enabled DESC, updated_at DESC`)
    .all() as MemoryRow[]
  return rows.map(rowToItem)
}

/** 某智能体生效的记忆(全局 + 绑定该人设),仅启用项,按更新时间排序 */
export function listMemoriesForAgent(agentId: string | null | undefined): string[] {
  const rows = getDb()
    .prepare(
      `SELECT content FROM agent_memory
       WHERE enabled = 1 AND (agent_id IS NULL OR agent_id = ?)
       ORDER BY updated_at DESC`
    )
    .all(agentId ?? null) as Array<{ content: string }>
  return rows.map((r) => r.content.trim()).filter(Boolean)
}

export function saveMemory(input: AgentMemoryInput): {
  ok: boolean
  error?: string
  item?: AgentMemoryItem
} {
  const content = (input.content || '').trim()
  if (!content) return { ok: false, error: '记忆内容不能为空' }
  const db = getDb()
  const now = Date.now()
  const agentId = (input.agentId ?? '').trim() || null
  if (input.id) {
    const info = db
      .prepare(
        `UPDATE agent_memory SET agent_id = ?, content = ?, enabled = ?, updated_at = ? WHERE id = ?`
      )
      .run(agentId, content, input.enabled === false ? 0 : 1, now, input.id)
    if (info.changes === 0) return { ok: false, error: '条目不存在' }
  } else {
    db.prepare(
      `INSERT INTO agent_memory (agent_id, content, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run(agentId, content, input.enabled === false ? 0 : 1, now, now)
  }
  const rows = db
    .prepare(`SELECT * FROM agent_memory WHERE content = ? ORDER BY id DESC LIMIT 1`)
    .all(content) as MemoryRow[]
  return rows.length > 0 ? { ok: true, item: rowToItem(rows[0]) } : { ok: false, error: '保存失败' }
}

export function removeMemory(id: number): boolean {
  const info = getDb().prepare(`DELETE FROM agent_memory WHERE id = ?`).run(id)
  return info.changes > 0
}
