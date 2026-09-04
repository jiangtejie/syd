import { getDb } from '../database'
import type { ChatMsgItem, ChatMsgKind, ChatMsgRole, ChatSessionItem } from '../../../shared/types'

/**
 * AI 助手会话/消息持久化(chat_session / chat_message)。
 */

interface ChatSessionRow {
  id: number
  wxid: string
  title: string
  agent_id: string | null
  created_at: number
  updated_at: number
}

interface ChatMsgRow {
  id: number
  session_id: number
  role: string
  kind: string
  content: string
  meta: string | null
  created_at: number
}

function rowToSession(r: ChatSessionRow): ChatSessionItem {
  return {
    id: r.id,
    wxid: r.wxid,
    title: r.title,
    agentId: r.agent_id ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

function rowToMsg(r: ChatMsgRow): ChatMsgItem {
  return {
    id: r.id,
    sessionId: r.session_id,
    role: (r.role === 'assistant' || r.role === 'system' ? r.role : 'user') as ChatMsgRole,
    kind: (['text', 'tool_call', 'tool_result', 'error'].includes(r.kind)
      ? r.kind
      : 'text') as ChatMsgKind,
    content: r.content,
    meta: r.meta ?? undefined,
    createdAt: r.created_at
  }
}

export function listChats(wxid: string): ChatSessionItem[] {
  const rows = getDb()
    .prepare(`SELECT * FROM chat_session WHERE wxid = ? ORDER BY updated_at DESC`)
    .all(wxid) as ChatSessionRow[]
  return rows.map(rowToSession)
}

export function createChat(wxid: string, title: string, agentId?: string | null): number {
  const now = Date.now()
  const info = getDb()
    .prepare(
      `INSERT INTO chat_session (wxid, title, agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    )
    .run(wxid, title, agentId ?? null, now, now)
  return Number(info.lastInsertRowid)
}

export function renameChat(id: number, title: string): boolean {
  const info = getDb()
    .prepare(`UPDATE chat_session SET title = ?, updated_at = ? WHERE id = ?`)
    .run(title.trim() || '新对话', Date.now(), id)
  return info.changes > 0
}

export function touchChat(id: number): void {
  getDb().prepare(`UPDATE chat_session SET updated_at = ? WHERE id = ?`).run(Date.now(), id)
}

export function setChatAgent(id: number, agentId: string | null): boolean {
  const info = getDb()
    .prepare(`UPDATE chat_session SET agent_id = ?, updated_at = ? WHERE id = ?`)
    .run(agentId, Date.now(), id)
  return info.changes > 0
}

export function removeChat(id: number): boolean {
  const db = getDb()
  db.prepare(`DELETE FROM chat_message WHERE session_id = ?`).run(id)
  const info = db.prepare(`DELETE FROM chat_session WHERE id = ?`).run(id)
  return info.changes > 0
}

export function listChatMessages(sessionId: number): ChatMsgItem[] {
  const rows = getDb()
    .prepare(`SELECT * FROM chat_message WHERE session_id = ? ORDER BY id ASC`)
    .all(sessionId) as ChatMsgRow[]
  return rows.map(rowToMsg)
}

export function appendChatMessage(
  sessionId: number,
  role: ChatMsgRole,
  kind: ChatMsgKind,
  content: string,
  meta?: Record<string, unknown> | null
): number {
  const info = getDb()
    .prepare(
      `INSERT INTO chat_message (session_id, role, kind, content, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(sessionId, role, kind, content, meta ? JSON.stringify(meta) : null, Date.now())
  return Number(info.lastInsertRowid)
}

export function clearChatMessages(sessionId: number): void {
  getDb().prepare(`DELETE FROM chat_message WHERE session_id = ?`).run(sessionId)
}

/** 会话最后一条 user 消息(供重试) */
export function lastUserMessage(sessionId: number): string | null {
  const row = getDb()
    .prepare(
      `SELECT content FROM chat_message WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1`
    )
    .get(sessionId) as { content: string } | undefined
  return row?.content ?? null
}

/** 会话挂载能力集合(JSON {v:1,names:string[]});无记录返回空数组 */
export function getChatCaps(sessionId: number): string[] {
  const row = getDb().prepare(`SELECT caps FROM chat_session WHERE id = ?`).get(sessionId) as
    { caps: string | null } | undefined
  if (!row?.caps) return []
  try {
    const parsed = JSON.parse(row.caps) as { names?: unknown }
    if (!Array.isArray(parsed.names)) return []
    return parsed.names.filter((n): n is string => typeof n === 'string')
  } catch {
    return []
  }
}

export function setChatCaps(sessionId: number, names: string[]): void {
  getDb()
    .prepare(`UPDATE chat_session SET caps = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify({ v: 1, names: [...new Set(names)] }), Date.now(), sessionId)
}

/** caps 是否已持久化过(NULL 视为从未;[] 视为用户清空,不再回默认挂载集) */
export function chatCapsPersisted(sessionId: number): boolean {
  const row = getDb().prepare(`SELECT caps FROM chat_session WHERE id = ?`).get(sessionId) as
    { caps: string | null } | undefined
  return !!row && row.caps !== null
}
