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
    kind: (['text', 'tool_call', 'tool_result', 'compact', 'error'].includes(r.kind)
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

/** 单查会话(校验外部映射的 session_id 是否仍存在,避免外键写入失败) */
export function getChatById(id: number): ChatSessionItem | null {
  const row = getDb().prepare(`SELECT * FROM chat_session WHERE id = ?`).get(id) as
    ChatSessionRow | undefined
  return row ? rowToSession(row) : null
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

/**
 * 只取最近 limit 条（按 id 倒序取再翻回升序）。
 * 引擎/每轮对话的上下文预算本来只有 40 条左右，却调用全量版本把整个会话读进内存。
 */
export function listChatMessagesTail(sessionId: number, limit: number): ChatMsgItem[] {
  const rows = getDb()
    .prepare(`SELECT * FROM chat_message WHERE session_id = ? ORDER BY id DESC LIMIT ?`)
    .all(sessionId, Math.max(1, limit)) as ChatMsgRow[]
  return rows.reverse().map(rowToMsg)
}

/** 最后一条助手文本(IM 回复通道用):一条 SQL 取代「读全量再 reverse 查找」 */
export function lastAssistantText(sessionId: number): string | null {
  const row = getDb()
    .prepare(
      `SELECT content FROM chat_message
       WHERE session_id = ? AND role = 'assistant' AND kind = 'text'
       ORDER BY id DESC LIMIT 1`
    )
    .get(sessionId) as { content: string } | undefined
  const text = row?.content?.trim()
  return text ? text : null
}

/** 消息内容检索(某命名空间全部会话;子串匹配避开 LIKE 通配符,含上下文片段) */
export function searchChatMessages(
  wxid: string,
  query: string,
  limit = 100
): Array<{
  sessionId: number
  sessionTitle: string
  msgId: number
  role: string
  kind: string
  content: string
  createdAt: number
}> {
  const q = (query || '').trim()
  if (!q) return []
  const rows = getDb()
    .prepare(
      `SELECT m.id AS msgId, m.session_id AS sessionId, m.role, m.kind, m.content,
              m.created_at AS createdAt, s.title AS sessionTitle
       FROM chat_message m
       JOIN chat_session s ON s.id = m.session_id
       WHERE s.wxid = ? AND instr(m.content, ?) > 0
       ORDER BY m.id DESC
       LIMIT ?`
    )
    .all(wxid, q, Math.max(1, Math.min(limit, 200))) as Array<{
    msgId: number
    sessionId: number
    role: string
    kind: string
    content: string
    createdAt: number
    sessionTitle: string
  }>
  return rows.map((r) => ({
    sessionId: r.sessionId,
    sessionTitle: r.sessionTitle ?? '',
    msgId: r.msgId,
    role: r.role,
    kind: r.kind,
    content: r.content,
    createdAt: r.createdAt
  }))
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

/** 删除会话最后一条消息(重试清理用) */
export function popLastChatMessage(sessionId: number): boolean {
  const info = getDb()
    .prepare(
      `DELETE FROM chat_message WHERE id = (SELECT MAX(id) FROM chat_message WHERE session_id = ?)`
    )
    .run(sessionId)
  return info.changes > 0
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

/* ── 工作区(会话绑定的真实目录) ── */

export function getChatWorkspace(sessionId: number): string | null {
  const row = getDb().prepare(`SELECT workspace FROM chat_session WHERE id = ?`).get(sessionId) as
    { workspace: string | null } | undefined
  return row?.workspace?.trim() || null
}

export function setChatWorkspace(sessionId: number, dir: string | null): void {
  getDb()
    .prepare(`UPDATE chat_session SET workspace = ?, updated_at = ? WHERE id = ?`)
    .run((dir ?? '').trim() || null, Date.now(), sessionId)
}

/* ── 工作台回答反馈(有用/没用;message_id 唯一,重复提交覆盖) ── */

export function saveMessageFeedback(input: {
  sessionId: number
  messageId: number
  value: 1 | -1
  reason?: string
}): void {
  const db = getDb()
  db.prepare(`DELETE FROM wb_feedback WHERE message_id = ?`).run(input.messageId)
  db.prepare(
    `INSERT INTO wb_feedback (session_id, message_id, value, reason, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(input.sessionId, input.messageId, input.value, input.reason ?? null, Date.now())
}

export function feedbackValueOf(messageId: number): 1 | -1 | null {
  const row = getDb()
    .prepare(`SELECT value FROM wb_feedback WHERE message_id = ?`)
    .get(messageId) as { value: number } | undefined
  return row ? (row.value === 1 ? 1 : -1) : null
}
