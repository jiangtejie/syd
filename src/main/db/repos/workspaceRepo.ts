import { getDb } from '../database'
import type { ChatMsgItem } from '../../../shared/types'

/** 工作区 Agent 会话/消息持久化(workspace_session / workspace_message)。 */

export interface WorkspaceSession {
  id: number
  cwd: string
  title: string
  createdAt: number
  updatedAt: number
}

interface WsSessionRow {
  id: number
  cwd: string
  title: string
  created_at: number
  updated_at: number
}

interface WsMsgRow {
  id: number
  session_id: number
  role: string
  kind: string
  content: string
  meta: string | null
  created_at: number
}

function rowToSession(r: WsSessionRow): WorkspaceSession {
  return {
    id: r.id,
    cwd: r.cwd,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

function rowToMsg(r: WsMsgRow): ChatMsgItem {
  return {
    id: r.id,
    sessionId: r.session_id,
    role: (r.role === 'assistant' || r.role === 'system' ? r.role : 'user') as ChatMsgItem['role'],
    kind: (['text', 'tool_call', 'tool_result', 'error'].includes(r.kind)
      ? r.kind
      : 'text') as ChatMsgItem['kind'],
    content: r.content,
    meta: r.meta ?? undefined,
    createdAt: r.created_at
  }
}

export function listWorkspaceSessions(): WorkspaceSession[] {
  const rows = getDb()
    .prepare(`SELECT * FROM workspace_session ORDER BY updated_at DESC`)
    .all() as WsSessionRow[]
  return rows.map(rowToSession)
}

export function getWorkspaceSession(id: number): WorkspaceSession | null {
  const row = getDb().prepare(`SELECT * FROM workspace_session WHERE id = ?`).get(id) as
    WsSessionRow | undefined
  return row ? rowToSession(row) : null
}

export function createWorkspaceSession(cwd: string, title: string): number {
  const now = Date.now()
  const info = getDb()
    .prepare(
      `INSERT INTO workspace_session (cwd, title, created_at, updated_at) VALUES (?, ?, ?, ?)`
    )
    .run(cwd, title || '工作区', now, now)
  return Number(info.lastInsertRowid)
}

export function renameWorkspaceSession(id: number, title: string): boolean {
  const info = getDb()
    .prepare(`UPDATE workspace_session SET title = ?, updated_at = ? WHERE id = ?`)
    .run(title.trim() || '工作区', Date.now(), id)
  return info.changes > 0
}

export function touchWorkspaceSession(id: number): void {
  getDb().prepare(`UPDATE workspace_session SET updated_at = ? WHERE id = ?`).run(Date.now(), id)
}

export function removeWorkspaceSession(id: number): boolean {
  const db = getDb()
  db.prepare(`DELETE FROM workspace_message WHERE session_id = ?`).run(id)
  const info = db.prepare(`DELETE FROM workspace_session WHERE id = ?`).run(id)
  return info.changes > 0
}

export function listWorkspaceMessages(sessionId: number): ChatMsgItem[] {
  const rows = getDb()
    .prepare(`SELECT * FROM workspace_message WHERE session_id = ? ORDER BY id ASC`)
    .all(sessionId) as WsMsgRow[]
  return rows.map(rowToMsg)
}

export function appendWorkspaceMessage(
  sessionId: number,
  role: ChatMsgItem['role'],
  kind: ChatMsgItem['kind'],
  content: string,
  meta?: Record<string, unknown> | null
): number {
  const info = getDb()
    .prepare(
      `INSERT INTO workspace_message (session_id, role, kind, content, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(sessionId, role, kind, content, meta ? JSON.stringify(meta) : null, Date.now())
  return Number(info.lastInsertRowid)
}

export function lastWorkspaceUserText(sessionId: number): string | null {
  const row = getDb()
    .prepare(
      `SELECT content FROM workspace_message WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1`
    )
    .get(sessionId) as { content: string } | undefined
  return row?.content ?? null
}

/** 清除某会话最近一条消息(重试用) */
export function popLastWorkspaceMessage(sessionId: number): boolean {
  const info = getDb()
    .prepare(
      `DELETE FROM workspace_message WHERE id = (SELECT MAX(id) FROM workspace_message WHERE session_id = ?)`
    )
    .run(sessionId)
  return info.changes > 0
}
