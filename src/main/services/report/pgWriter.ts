import { Client } from 'pg'
import type { ReportPgTarget } from '../../../shared/types'

/**
 * 数据上报 · PostgreSQL 目标写入器。
 * 表结构与 upsert 语义与 chat-sync(chat.sessions / chat.messages)完全兼容:
 * - CREATE SCHEMA/TABLE IF NOT EXISTS + 唯一约束/索引补加 + 旧表缺列 ALTER;
 * - 幂等 ON CONFLICT upsert(media_path 只补空不覆盖等);
 * - 连接加固:10s 快速失败、statement_timeout 60s。
 */

export interface PgSessionRow {
  sessionId: string
  displayName: string
  sessionType: string
  ownerId: string | null
  messageCount: number | null
  firstMessageTime: number | null
  lastMessageTime: number | null
  exportedAt: number
}

export interface PgMessageRow {
  sessionWxid: string
  localId: number
  createTime: number
  formattedTime: string
  msgType: string
  content: string
  isSend: number
  senderUsername: string | null
  senderDisplayName: string | null
  groupNickname: string | null
  replyToMessageId: string | null
  mediaMd5: string | null
  mediaPath: string | null
  /** 语音转写文本（非语音 / 未转写为 null）；与 content 里的「[语音] N″ 文本」同源，供下游直接筛 */
  voiceText: string | null
  /** 语音时长（毫秒，来自消息 XML 的 voicelength；非语音为 null） */
  voiceDurationMs: number | null
}

/** 语音转写完成后回写的行（消息已入库，只补语音相关列） */
export interface VoicePgUpdate {
  sessionWxid: string
  localId: number
  content: string
  voiceText: string
  voiceDurationMs: number | null
}

function clientOf(t: ReportPgTarget): Client {
  return new Client({
    host: t.host,
    port: t.port || 5432,
    database: t.database,
    user: t.user,
    password: t.password ?? '',
    connectionTimeoutMillis: 10_000,
    options: '-c statement_timeout=60000'
  })
}

/** 连接测试(供设置页「测试连接」):建连 + SELECT 1 */
export async function testPgConnection(
  t: ReportPgTarget
): Promise<{ ok: boolean; error?: string }> {
  const c = clientOf(t)
  try {
    await c.connect()
    await c.query('SELECT 1')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    await c.end().catch(() => undefined)
  }
}

/** 幂等建表/加约束/补索引(与 chat-sync initDb 同款;已存在的库不破坏数据) */
export async function ensurePgSchema(c: Client, schema: string): Promise<void> {
  const q = (sql: string): Promise<unknown> => c.query(sql)
  await q(`CREATE SCHEMA IF NOT EXISTS ${quoteId(schema)}`)
  await q(`CREATE TABLE IF NOT EXISTS ${qn(schema, 'sessions')} (
    wxid TEXT, display_name TEXT, session_type TEXT, owner_id TEXT,
    message_count INTEGER, first_message_time BIGINT, last_message_time BIGINT, exported_at BIGINT
  )`)
  await q(`CREATE TABLE IF NOT EXISTS ${qn(schema, 'messages')} (
    id SERIAL, session_wxid TEXT, local_id INTEGER, create_time BIGINT,
    formatted_time TEXT, msg_type TEXT, content TEXT, is_send SMALLINT,
    sender_username TEXT, sender_display_name TEXT, group_nickname TEXT,
    reply_to_message_id TEXT, media_md5 TEXT, media_path TEXT,
    voice_text TEXT, voice_duration_ms INTEGER
  )`)
  // 唯一约束(表已存在时补加)
  await q(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_messages_session_local') THEN
      ALTER TABLE ${qn(schema, 'messages')} ADD CONSTRAINT uniq_messages_session_local UNIQUE (session_wxid, local_id);
    END IF; END $$`)
  await q(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_sessions_wxid') THEN
      ALTER TABLE ${qn(schema, 'sessions')} ADD CONSTRAINT uniq_sessions_wxid UNIQUE (wxid);
    END IF; END $$`)
  await q(
    `CREATE INDEX IF NOT EXISTS idx_messages_create_time ON ${qn(schema, 'messages')}(create_time)`
  )
  await q(
    `CREATE INDEX IF NOT EXISTS idx_messages_sender ON ${qn(schema, 'messages')}(sender_username)`
  )
  await q(
    `CREATE INDEX IF NOT EXISTS idx_messages_session_time ON ${qn(schema, 'messages')}(session_wxid, create_time)`
  )
  // 旧表缺列补加(媒体元数据)
  await q(`ALTER TABLE ${qn(schema, 'messages')} ADD COLUMN IF NOT EXISTS media_md5 TEXT`)
  await q(`ALTER TABLE ${qn(schema, 'messages')} ADD COLUMN IF NOT EXISTS media_path TEXT`)
  // 语音：时长（所有语音都有）+ 转写文本（转写成功后回写）
  await q(`ALTER TABLE ${qn(schema, 'messages')} ADD COLUMN IF NOT EXISTS voice_text TEXT`)
  await q(
    `ALTER TABLE ${qn(schema, 'messages')} ADD COLUMN IF NOT EXISTS voice_duration_ms INTEGER`
  )
}

function quoteId(s: string): string {
  return `"${s.replace(/"/g, '""')}"`
}

function qn(schema: string, table: string): string {
  return `${quoteId(schema)}.${quoteId(table)}`
}

export async function upsertPgSessions(
  c: Client,
  schema: string,
  rows: PgSessionRow[]
): Promise<void> {
  if (rows.length === 0) return
  const values: string[] = []
  const params: unknown[] = []
  let i = 1
  for (const r of rows) {
    values.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`)
    params.push(
      r.sessionId,
      r.displayName || r.sessionId,
      r.sessionType,
      r.ownerId,
      r.messageCount,
      r.firstMessageTime,
      r.lastMessageTime,
      r.exportedAt
    )
  }
  await c.query(
    `INSERT INTO ${qn(schema, 'sessions')}
       (wxid, display_name, session_type, owner_id, message_count, first_message_time, last_message_time, exported_at)
     VALUES ${values.join(',')}
     ON CONFLICT (wxid) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       session_type = EXCLUDED.session_type,
       owner_id = EXCLUDED.owner_id,
       message_count = COALESCE(EXCLUDED.message_count, ${qn(schema, 'sessions')}.message_count),
       last_message_time = COALESCE(EXCLUDED.last_message_time, ${qn(schema, 'sessions')}.last_message_time),
       exported_at = EXCLUDED.exported_at`,
    params
  )
}

export async function upsertPgMessages(
  c: Client,
  schema: string,
  rows: PgMessageRow[]
): Promise<void> {
  if (rows.length === 0) return
  const values: string[] = []
  const params: unknown[] = []
  let i = 1
  for (const r of rows) {
    values.push(
      `($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`
    )
    params.push(
      r.sessionWxid,
      r.localId,
      r.createTime,
      r.formattedTime,
      r.msgType,
      r.content,
      r.isSend,
      r.senderUsername,
      r.senderDisplayName,
      r.groupNickname,
      r.replyToMessageId,
      r.mediaMd5,
      r.mediaPath,
      r.voiceText,
      r.voiceDurationMs
    )
  }
  await c.query(
    `INSERT INTO ${qn(schema, 'messages')}
       (session_wxid, local_id, create_time, formatted_time, msg_type, content, is_send,
        sender_username, sender_display_name, group_nickname, reply_to_message_id, media_md5, media_path,
        voice_text, voice_duration_ms)
     VALUES ${values.join(',')}
     ON CONFLICT (session_wxid, local_id) DO UPDATE SET
       content = EXCLUDED.content,
       msg_type = EXCLUDED.msg_type,
       create_time = EXCLUDED.create_time,
       formatted_time = EXCLUDED.formatted_time,
       sender_display_name = EXCLUDED.sender_display_name,
       sender_username = COALESCE(EXCLUDED.sender_username, ${qn(schema, 'messages')}.sender_username),
       media_md5 = COALESCE(EXCLUDED.media_md5, ${qn(schema, 'messages')}.media_md5),
       voice_text = COALESCE(EXCLUDED.voice_text, ${qn(schema, 'messages')}.voice_text),
       voice_duration_ms = COALESCE(EXCLUDED.voice_duration_ms, ${qn(schema, 'messages')}.voice_duration_ms),
       media_path = CASE WHEN EXCLUDED.media_path IS NOT NULL AND EXCLUDED.media_path != ''
                          AND (${qn(schema, 'messages')}.media_path IS NULL OR ${qn(schema, 'messages')}.media_path = '')
                        THEN EXCLUDED.media_path ELSE ${qn(schema, 'messages')}.media_path END`,
    params
  )
}

/** 回填会话聚合(message_count / 首条时间;last_message_time 已在 upsert 时更新) */
export async function refreshPgSessionStats(
  c: Client,
  schema: string,
  touched: string[]
): Promise<void> {
  if (touched.length === 0) return
  await c.query(
    `UPDATE ${qn(schema, 'sessions')} s SET
       message_count = (SELECT COUNT(*) FROM ${qn(schema, 'messages')} m WHERE m.session_wxid = s.wxid),
       first_message_time = COALESCE(
         s.first_message_time,
         (SELECT MIN(m.create_time) FROM ${qn(schema, 'messages')} m WHERE m.session_wxid = s.wxid)
       )
     WHERE s.wxid = ANY($1)`,
    [touched]
  )
}

export async function closePg(c: Client): Promise<void> {
  await c.end().catch(() => undefined)
}

/**
 * 语音转写回写：消息已经入库（content 是 `[语音]`），转写成功后把文本补进去。
 *
 * 只对「还没有 voice_text 或 content 仍是 `[语音]` 占位」的行生效 —— 不回写就不会覆盖下游/人工改过的内容。
 * 单轮条数由调用方预算控制（几条到几十条），逐条 UPDATE 足够，不必拼批量 VALUES。
 */
export async function updatePgVoice(
  c: Client,
  schema: string,
  rows: VoicePgUpdate[]
): Promise<number> {
  if (rows.length === 0) return 0
  let done = 0
  for (const r of rows) {
    const res = await c.query(
      `UPDATE ${qn(schema, 'messages')}
          SET content = $1,
              voice_text = $2,
              voice_duration_ms = COALESCE($3, voice_duration_ms)
        WHERE session_wxid = $4 AND local_id = $5
          AND (voice_text IS NULL OR voice_text = '' OR content = '[语音]')`,
      [r.content, r.voiceText, r.voiceDurationMs, r.sessionWxid, r.localId]
    )
    done += res.rowCount ?? 0
  }
  return done
}
