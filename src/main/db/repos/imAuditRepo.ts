import { getConfig, setConfig } from './config'
import { getDb } from '../database'
import { createLogger } from '../../services/logging'
import type { ImAuditEntry } from '../../../shared/types'

const log = createLogger('im')

/**
 * im_audit:IM 入站审计 + 任务生命周期(合并原 im_command_log 与 im_task)。
 * - 一条入站消息/指令 = 一行:kind 区分 message/command/rejected;
 * - 被接收策略拒绝的消息也留痕(status=skipped,无 session);
 * - 任务状态机:queued → running → done | failed | cancelled(超时/取代/取消都有明确终态);
 * - 所有写入失败都不影响主流程(审计不能成为单点)。
 */

export type ImAuditKind = 'message' | 'command' | 'rejected'
export type ImAuditStatus =
  'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'ok' | 'error' | 'skipped'

/** 行结构与渲染端共用(shared/types.ts),避免两处手抄 */
export type ImAuditRow = ImAuditEntry

function mapRow(r: Record<string, unknown>): ImAuditRow {
  return {
    id: Number(r.id),
    accountId: Number(r.account_id),
    chatId: String(r.chat_id ?? ''),
    sessionId: r.session_id === null ? null : Number(r.session_id),
    senderOpenId: String(r.sender_open_id ?? ''),
    chatType: String(r.chat_type ?? ''),
    kind: String(r.kind ?? 'message'),
    text: String(r.text ?? ''),
    status: String(r.status ?? 'queued'),
    progress: String(r.progress ?? ''),
    result: String(r.result ?? ''),
    replyLen: Number(r.reply_len ?? 0),
    tools: String(r.tools ?? ''),
    elapsedMs: Number(r.elapsed_ms ?? 0),
    error: String(r.error ?? ''),
    createdAt: Number(r.created_at ?? 0),
    startedAt: r.started_at === null || r.started_at === undefined ? null : Number(r.started_at),
    finishedAt: r.finished_at === null || r.finished_at === undefined ? null : Number(r.finished_at)
  }
}

export function insertImAudit(input: {
  accountId: number
  chatId: string
  sessionId: number | null
  senderOpenId: string
  chatType: string
  kind: ImAuditKind
  text: string
  status?: ImAuditStatus
  error?: string
}): number {
  const info = getDb()
    .prepare(
      `INSERT INTO im_audit
        (account_id, chat_id, session_id, sender_open_id, chat_type, kind, text, status,
         progress, result, reply_len, tools, elapsed_ms, error, created_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '', 0, '', 0, ?, ?, NULL, ?)`
    )
    .run(
      input.accountId,
      input.chatId,
      input.sessionId,
      input.senderOpenId,
      input.chatType,
      input.kind,
      (input.text ?? '').slice(0, 500),
      input.status ?? 'queued',
      (input.error ?? '').slice(0, 500),
      Date.now(),
      input.status === 'skipped' ? Date.now() : null
    )
  return Number(info.lastInsertRowid)
}

export function startImAudit(id: number | null): void {
  if (!id) return
  getDb()
    .prepare(`UPDATE im_audit SET status = 'running', started_at = ? WHERE id = ?`)
    .run(Date.now(), id)
}

export function updateImAuditProgress(id: number | null, progress: string): void {
  if (!id) return
  getDb()
    .prepare(`UPDATE im_audit SET progress = ? WHERE id = ? AND status = 'running'`)
    .run((progress ?? '').slice(0, 200), id)
}

/** 收尾:终态 + 结果/耗时/工具/错误(已完成的行不覆盖,避免迟到回调改写终态) */
export function finishImAudit(
  id: number | null,
  patch: {
    status: ImAuditStatus
    result?: string
    replyLen?: number
    elapsedMs?: number
    error?: string
    tools?: string[]
  }
): void {
  if (!id) return
  getDb()
    .prepare(
      `UPDATE im_audit
         SET status = ?, result = ?, reply_len = ?, elapsed_ms = ?, error = ?, tools = ?, finished_at = ?
       WHERE id = ? AND status IN ('queued','running')`
    )
    .run(
      patch.status,
      (patch.result ?? '').slice(0, 4000),
      patch.replyLen ?? 0,
      patch.elapsedMs ?? 0,
      (patch.error ?? '').slice(0, 500),
      (patch.tools ?? []).slice(0, 30).join(','),
      Date.now(),
      id
    )
}

/** 本会话正在执行的行(取消用) */
export function findRunningImAudit(accountId: number, chatId: string): ImAuditRow | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM im_audit WHERE account_id = ? AND chat_id = ? AND status IN ('queued','running')
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(accountId, chatId) as Record<string, unknown> | undefined
  return row ? mapRow(row) : null
}

export function getImAudit(id: number): ImAuditRow | null {
  const row = getDb().prepare(`SELECT * FROM im_audit WHERE id = ?`).get(id) as
    Record<string, unknown> | undefined
  return row ? mapRow(row) : null
}

/** 本会话最近任务(message/command;不含被拒) */
export function listImAuditByChat(accountId: number, chatId: string, limit = 8): ImAuditRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM im_audit WHERE account_id = ? AND chat_id = ? AND kind <> 'rejected'
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(accountId, chatId, Math.min(Math.max(limit, 1), 50)) as Array<Record<string, unknown>>
  return rows.map(mapRow)
}

/** 全渠道最近记录(桌面面板:onlyTasks=false 时含被拒消息) */
export function listRecentImAudit(limit = 20, opts: { onlyTasks?: boolean } = {}): ImAuditRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM im_audit ${opts.onlyTasks ? "WHERE kind <> 'rejected'" : ''}
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(Math.min(Math.max(limit, 1), 200)) as Array<Record<string, unknown>>
  return rows.map(mapRow)
}

/**
 * 老库迁移:im_command_log + im_task → im_audit(幂等,只跑一次;老表保留不删)。
 * 任务表带 id 先入(保留 /task <id> 的历史引用),审计表随后补入(新 id)。
 */
export function migrateLegacyImAudit(): void {
  if (getConfig('im.audit.migrated') === '1') return
  const db = getDb()
  let moved = 0
  const exists = (table: string): boolean =>
    !!db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)
  // 两张老表各自独立 try:单表失败只记日志,不阻塞另一张,也不会因反复重启无限重试
  try {
    if (exists('im_task')) {
      const r = db
        .prepare(
          `INSERT OR IGNORE INTO im_audit (id, account_id, chat_id, session_id, sender_open_id, chat_type, kind,
             text, status, progress, result, reply_len, tools, elapsed_ms, error, created_at, started_at, finished_at)
           SELECT id, account_id, chat_id, session_id, sender_open_id, '', 'message',
             title, status, progress, result, 0, '', 0, error, created_at, started_at, finished_at
           FROM im_task`
        )
        .run()
      moved += Number(r.changes ?? 0)
    }
  } catch (e) {
    log.warn(`im_task 迁移失败(跳过): ${e instanceof Error ? e.message : String(e)}`)
  }
  try {
    if (exists('im_command_log')) {
      const r = db
        .prepare(
          `INSERT INTO im_audit (account_id, chat_id, session_id, sender_open_id, chat_type, kind,
             text, status, progress, result, reply_len, tools, elapsed_ms, error, created_at, started_at, finished_at)
           SELECT account_id, chat_id, session_id, sender_open_id, chat_type, kind,
             text, status, '', '', reply_len, tools, elapsed_ms, error, created_at, NULL, finished_at
           FROM im_command_log`
        )
        .run()
      moved += Number(r.changes ?? 0)
    }
  } catch (e) {
    log.warn(`im_command_log 迁移失败(跳过): ${e instanceof Error ? e.message : String(e)}`)
  }
  setConfig('im.audit.migrated', '1')
  if (moved > 0) log.info(`im_audit 迁移完成:并入 ${moved} 条历史记录`)
}
