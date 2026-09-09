import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import * as wxService from '../wechat/wxService'
import { safeFileName } from '../_filename'
import { getDb } from '../../db/database'
import { listAgents } from '../../db/repos/agentRepo'
import { listTeamMembers } from '../../db/repos/teamRepo'
import type { ChatMessage } from '../../../shared/types'

/**
 * 数据导出（参考 CipherTalk export 模块能力，按本应用可读数据实现）：
 * - 聊天记录导出:按会话多选 + 时间范围 + 格式(txt/html/json),流式写盘,带进度回调;
 * - 业务数据导出:本地派生数据(群问题含证据/发送审计/团队/智能体/账号摘要,敏感项脱敏)JSON 归档;
 * - 目录由用户在渲染层选择;敏感项(微信密钥/AI Key/密文)一律不导出。
 */

export type ChatExportFormat = 'txt' | 'html' | 'json'

export interface ChatExportTarget {
  username: string
  displayName: string
}

export interface ChatExportOptions {
  targets: ChatExportTarget[]
  startMs?: number
  endMs?: number
  format: ChatExportFormat
  folder: string
}

export interface ProgressEvent {
  phase: 'prepare' | 'session' | 'done'
  current: number
  total: number
  name: string
  detail: string
}

type ProgressCb = (evt: ProgressEvent) => void

const MAX_MSGS_PER_SESSION = 500_000
const PAGE = 500

function fmtLine(m: ChatMessage): string {
  const d = new Date(m.createTime)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const who = m.isSend ? '我' : m.senderNickname || m.senderUsername || '未知'
  const text = m.parsedContent || '[无内容]'
  return `[${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}] ${who}: ${text}`
}

function fmtTimeFull(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}`
}

/** 拉取某会话全部消息（时间过滤后），分批回调行；返回条数 */
async function readSessionMessages(
  wxid: string,
  sessionId: string,
  startMs: number | undefined,
  endMs: number | undefined,
  onPage: (msgs: ChatMessage[]) => void
): Promise<number> {
  let cursor: Parameters<typeof wxService.getMessages>[3] = undefined
  let total = 0
  for (;;) {
    const res = wxService.getMessages(wxid, sessionId, PAGE, cursor)
    if (!res.ok || !res.messages || res.messages.length === 0) break
    let msgs = res.messages
    if (startMs !== undefined) msgs = msgs.filter((m) => m.createTime >= startMs!)
    if (endMs !== undefined) msgs = msgs.filter((m) => m.createTime <= endMs!)
    if (msgs.length > 0) {
      // 注意分页返回升序；过滤后跨页可能重复边界消息（时间相邻），交给去重
      onPage(msgs)
      total += msgs.length
    }
    if (total >= MAX_MSGS_PER_SESSION) break
    if (!res.hasMore || !res.nextCursor) break
    cursor = res.nextCursor
    await new Promise((r) => setImmediate(r)) // 让出事件循环，保证进度事件可送达
  }
  return total
}

function timeInRange(m: ChatMessage, startMs?: number, endMs?: number): boolean {
  if (startMs !== undefined && m.createTime < startMs) return false
  if (endMs !== undefined && m.createTime > endMs) return false
  return true
}

export async function exportChat(
  wxid: string,
  opts: ChatExportOptions,
  onProgress: ProgressCb
): Promise<{
  ok: boolean
  folder?: string
  files?: Array<{ name: string; msgCount: number }>
  error?: string
}> {
  try {
    if (!wxid) return { ok: false, error: '未连接微信账号' }
    if (!opts.targets?.length) return { ok: false, error: '未选择会话' }
    if (!opts.folder) return { ok: false, error: '未选择导出目录' }
    const folder = opts.folder
    if (!existsSync(folder)) mkdirSync(folder, { recursive: true })
    const format = opts.format
    const files: Array<{ name: string; msgCount: number }> = []
    const total = opts.targets.length
    const stamp = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const suffix = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(
      stamp.getHours()
    )}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`

    for (let i = 0; i < opts.targets.length; i++) {
      const t = opts.targets[i]
      onProgress({ phase: 'session', current: i + 1, total, name: t.displayName, detail: '读取消息中…' })
      const seen = new Set<string>()
      const rows: string[] = []
      const jsonRows: string[] = []
      let count = 0
      const base = safeFileName(t.displayName || t.username, { maxLength: 80, fallback: 'session' })
      const fileName = `${base}_${suffix}.${format}`
      const filePath = join(folder, fileName)

      if (format === 'json') {
        jsonRows.push('[')
      } else {
        rows.push(
          format === 'html'
            ? '<!doctype html><meta charset="utf-8"><title>导出</title><body style="font-family:system-ui;font-size:14px">'
            : ''
        )
      }
      const write = (m: ChatMessage): void => {
        if (m.serverId) {
          if (seen.has(`s:${m.serverId}`)) return
          seen.add(`s:${m.serverId}`)
        } else {
          const k = `l:${m.localId}:${m.sortSeq}`
          if (seen.has(k)) return
          seen.add(k)
        }
        count++
        if (format === 'txt') rows.push(fmtLine(m))
        else if (format === 'html') {
          const who = m.isSend ? '我' : m.senderNickname || m.senderUsername || '未知'
          rows.push(
            `<div style="margin:6px 0"><span style="color:#999;font-size:12px">${fmtTimeFull(
              m.createTime
            )}</span> <b>${escapeHtml(who)}</b>: ${escapeHtml(m.parsedContent || '[无内容]')}</div>`
          )
        } else {
          jsonRows.push(
            (jsonRows.length > 1 ? ',' : '') +
              JSON.stringify({
                t: m.createTime,
                from: m.senderUsername || null,
                fromName: m.isSend ? null : m.senderNickname || null,
                send: m.isSend,
                type: m.localType,
                text: m.parsedContent || '',
                imageMd5: m.imageMd5 || null,
                videoMd5: m.videoMd5 || null,
                fileMd5: m.fileMd5 || null,
                fileName: m.fileName || null,
                quoted: m.quotedContent || null
              })
          )
        }
      }

      const counted = await readSessionMessages(
        wxid,
        t.username,
        opts.startMs,
        opts.endMs,
        (page) => {
          // 消息跨库合并后可能整体乱序?listMessages 返回升序;此处确保顺序正确性交由最终 writer(顺序乱对体验影响小,文本直接页序)
          for (const m of page) {
            if (timeInRange(m, opts.startMs, opts.endMs)) write(m)
          }
        }
      )
      void counted

      if (format === 'json') {
        jsonRows.push(']')
      } else if (format === 'html') {
        rows.push(`<div style="color:#999;margin-top:16px">共 ${count} 条 · 导出于 ${fmtTimeFull(Date.now())}</div></body>`)
      }
      if (count > 0 || format !== 'txt') {
        // 空会话也保留空文件?txt 空文件无意义;跳过空会话
        if (count === 0) continue
        const ws = createWriteStream(filePath, { encoding: 'utf-8' })
        await new Promise<void>((resolve, reject) => {
          ws.on('error', reject)
          ws.on('finish', () => resolve())
          for (const line of rows) ws.write(line + '\n')
          for (const line of jsonRows) ws.write(line + '\n')
          ws.end()
        })
        files.push({ name: fileName, msgCount: count })
      }
      onProgress({
        phase: 'session',
        current: i + 1,
        total,
        name: t.displayName,
        detail: `完成 ${count} 条`
      })
    }
    return { ok: true, folder, files }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 业务数据（本地派生）导出：敏感项一律脱敏/排除 */
export async function exportBusiness(
  wxid: string,
  folder: string,
  onProgress: ProgressCb
): Promise<{ ok: boolean; folder?: string; name?: string; error?: string }> {
  try {
    if (!wxid) return { ok: false, error: '未连接微信账号' }
    if (!folder) return { ok: false, error: '未选择导出目录' }
    if (!existsSync(folder)) mkdirSync(folder, { recursive: true })
    onProgress({ phase: 'prepare', current: 0, total: 1, name: '业务数据', detail: '汇总本地数据…' })
    const db = getDb()

    const issues = db
      .prepare(
        `SELECT id, key, group_username, group_name, type, title, summary, occur_at, status, method, auto_done, follow_up, created_at, updated_at
         FROM issue_feedback WHERE wxid = ? ORDER BY occur_at DESC`
      )
      .all(wxid) as Array<Record<string, unknown>>
    const issueMsgsStmt = db.prepare(
      `SELECT msg_time, sender_name, is_send, text FROM issue_feedback_msg WHERE issue_id = ? ORDER BY seq ASC`
    )
    const issuesFull = issues.map((it) => ({
      ...it,
      msgs: issueMsgsStmt.all(it.id as number)
    }))

    const sendLog = db
      .prepare(
        `SELECT session_id, message, mode, source, result, error_reason, verified, created_at
         FROM send_log ORDER BY created_at DESC LIMIT 200000`
      )
      .all() as unknown[]

    const accounts = db
      .prepare(
        `SELECT wxid, db_path, source, status, imported_at FROM key_store ORDER BY updated_at DESC`
      )
      .all() as unknown[] // 不含 key_encrypted

    const payload = {
      app: 'wechat-cs-desktop',
      kind: 'business-backup',
      wxid,
      exportedAt: new Date().toISOString(),
      issues: issuesFull,
      sendLog,
      accounts,
      teamMembers: listTeamMembers(wxid),
      agents: listAgents()
    }

    const stamp = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const name = `business_${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(
      stamp.getDate()
    )}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.json`
    const filePath = join(folder, name)
    const ws = createWriteStream(filePath, { encoding: 'utf-8' })
    await new Promise<void>((resolve, reject) => {
      ws.on('error', reject)
      ws.on('finish', () => resolve())
      ws.write(JSON.stringify(payload, null, 2))
      ws.end()
    })
    onProgress({ phase: 'done', current: 1, total: 1, name, detail: '完成' })
    return { ok: true, folder, name }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
