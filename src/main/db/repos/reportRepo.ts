import { getDb } from '../database'
import { sealSecret, openSecret } from '../../services/secrets'
import type {
  ReportChatScope,
  ReportJobInfo,
  ReportJobInput,
  ReportPgTarget,
  ReportRunInfo,
  ReportScheduleKind
} from '../../../shared/types'

/**
 * 数据上报·定时任务持久化(report_job / report_cursor / report_run)。
 * - 目标库口令以 safeStorage enc1 密文存于 params.target.pw;
 * - 游标按 (job_id, session_wxid) 存本地,整轮成功后才推进(防半截游标);
 * - 运行历史供设置页展示与排障,超量自动清理。
 */

interface JobRow {
  id: number
  name: string
  type: string
  enabled: number
  schedule_kind: string
  interval_sec: number
  daily_time: string
  params: string
  last_status: string | null
  last_summary: string | null
  last_at: number | null
  next_at: number | null
  created_at: number
  updated_at: number
}

interface RunRow {
  id: number
  job_id: number
  trigger: string
  status: string
  added: number
  sessions_ok: number
  sessions_skip: number
  errors: string | null
  started_at: number
  ended_at: number | null
  duration_ms: number | null
}

interface StoredParams {
  v?: number
  accountWxid: string
  sessionMode: ReportChatScope['sessionMode']
  sessionList?: string
  daysBack?: number
  maxPerRun?: number
  /** 媒体归档根目录(可选;留空 = userData/report-media/<账号>) */
  mediaDir?: string
  target?: {
    host: string
    port: number
    database: string
    user: string
    schema: string
    /** sealSecret 密文;空 = 无口令(测试库/免密场景) */
    pw?: string
  }
}

function parseParams(raw: string): StoredParams {
  try {
    return JSON.parse(raw) as StoredParams
  } catch {
    return { accountWxid: '', sessionMode: 'all' }
  }
}

/** 明文运行配置(供 runner 使用;口令解密失败抛错由调用方兜底) */
export function openJobRunConfig(jobId: number): {
  accountWxid: string
  scope: ReportChatScope
  target: ReportPgTarget
} | null {
  const row = getDb().prepare(`SELECT params FROM report_job WHERE id = ?`).get(jobId) as
    { params: string } | undefined
  if (!row) return null
  const p = parseParams(row.params)
  const t = p.target
  if (!t) return null
  return {
    accountWxid: p.accountWxid,
    scope: {
      sessionMode: p.sessionMode ?? 'all',
      sessionList: p.sessionList,
      daysBack: typeof p.daysBack === 'number' ? p.daysBack : 0,
      maxPerRun: typeof p.maxPerRun === 'number' ? p.maxPerRun : 0,
      mediaDir: p.mediaDir
    },
    target: {
      host: t.host,
      port: Number(t.port) || 5432,
      database: t.database,
      user: t.user,
      schema: t.schema || 'chat',
      password: t.pw ? openSecret(t.pw) : undefined
    }
  }
}

function toInfo(r: JobRow): ReportJobInfo {
  const p = parseParams(r.params)
  const t = p.target
  const scope: ReportChatScope = {
    sessionMode: p.sessionMode ?? 'all',
    sessionList: p.sessionList,
    daysBack: typeof p.daysBack === 'number' ? p.daysBack : 0,
    maxPerRun: typeof p.maxPerRun === 'number' ? p.maxPerRun : 0,
    mediaDir: p.mediaDir
  }
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    enabled: r.enabled === 1,
    scheduleKind: (r.schedule_kind === 'interval' || r.schedule_kind === 'daily'
      ? r.schedule_kind
      : 'manual') as ReportScheduleKind,
    intervalSec: r.interval_sec,
    dailyTime: r.daily_time,
    accountWxid: p.accountWxid ?? '',
    scope,
    target: {
      host: t?.host ?? '',
      port: Number(t?.port) || 5432,
      database: t?.database ?? '',
      user: t?.user ?? '',
      schema: t?.schema || 'chat',
      hasPassword: !!(t?.pw && t.pw.trim())
    },
    lastStatus: r.last_status ?? undefined,
    lastSummary: r.last_summary ?? undefined,
    lastAt: r.last_at ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

function validateJob(input: ReportJobInput): { ok: boolean; error?: string } {
  if (!input.name?.trim()) return { ok: false, error: '请填写任务名称' }
  if (input.type !== 'chat_sync') return { ok: false, error: '不支持的任务类型' }
  const t = input.target ?? ({} as ReportPgTarget)
  if (!t.host?.trim() || !t.database?.trim() || !t.user?.trim()) {
    return { ok: false, error: '请填写完整的目标连接(主机/库名/用户)' }
  }
  const sk = input.scheduleKind ?? 'manual'
  if (
    sk === 'interval' &&
    (!Number.isFinite(Number(input.intervalSec)) || Number(input.intervalSec) < 30)
  ) {
    return { ok: false, error: '间隔需 ≥30 秒' }
  }
  if (sk === 'daily' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.dailyTime ?? '')) {
    return { ok: false, error: '每日定点时间格式需为 HH:mm' }
  }
  if (!input.accountWxid?.trim()) return { ok: false, error: '请选择上报数据来源账号' }
  if (input.scope?.sessionMode === 'list' && !input.scope.sessionList?.trim()) {
    return { ok: false, error: '白名单模式需要填写会话列表' }
  }
  return { ok: true }
}

export function listReportJobs(): ReportJobInfo[] {
  const rows = getDb()
    .prepare(`SELECT * FROM report_job ORDER BY created_at DESC`)
    .all() as JobRow[]
  return rows.map(toInfo)
}

export function getReportJob(id: number): ReportJobInfo | null {
  const r = getDb().prepare(`SELECT * FROM report_job WHERE id = ?`).get(id) as JobRow | undefined
  return r ? toInfo(r) : null
}

/** 保存/新建;返回任务 id。新填口令才覆盖;编辑留空沿用密文。 */
export function saveReportJob(input: ReportJobInput): { ok: boolean; error?: string; id?: number } {
  const v = validateJob(input)
  if (!v.ok) return v
  const now = Date.now()
  const db = getDb()
  const accountWxid = input.accountWxid.trim()
  // 同一来源账号 + 同类型只允许一个(避免重复上报同一批数据)
  if (isAccountJobDuplicate(input.type, accountWxid, input.id)) {
    return { ok: false, error: '该账号已存在同类型任务,请编辑已有任务或更换账号' }
  }
  const tgt: NonNullable<StoredParams['target']> = {
    host: input.target.host.trim(),
    port: Math.floor(Number(input.target.port)) || 5432,
    database: input.target.database.trim(),
    user: input.target.user.trim(),
    schema: input.target.schema?.trim() || 'chat'
  }
  const params: StoredParams = {
    v: 1,
    accountWxid: input.accountWxid.trim(),
    sessionMode: input.scope.sessionMode,
    sessionList: input.scope.sessionList?.trim() || undefined,
    daysBack: Math.max(0, Math.floor(Number(input.scope.daysBack) || 0)),
    maxPerRun: Math.max(0, Math.floor(Number(input.scope.maxPerRun) || 0)),
    mediaDir: input.scope.mediaDir?.trim() || undefined,
    target: tgt
  }
  const prevParams =
    input.id !== undefined
      ? (() => {
          const row = db.prepare(`SELECT params FROM report_job WHERE id = ?`).get(input.id) as
            { params: string } | undefined
          return row ? parseParams(row.params) : null
        })()
      : null
  tgt.pw =
    input.target.password?.trim() !== undefined && input.target.password.trim() !== ''
      ? sealSecret(input.target.password.trim())
      : prevParams?.target?.pw
  const json = JSON.stringify(params)
  const enabled = input.enabled ? 1 : 0
  if (input.id !== undefined) {
    const info = db
      .prepare(
        `UPDATE report_job SET name = ?, type = ?, enabled = ?, schedule_kind = ?, interval_sec = ?,
         daily_time = ?, params = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        input.name.trim(),
        'chat_sync',
        enabled,
        input.scheduleKind ?? 'manual',
        input.scheduleKind === 'interval' ? Math.floor(Number(input.intervalSec) || 0) : 0,
        input.scheduleKind === 'daily' ? (input.dailyTime ?? '') : '',
        json,
        now,
        input.id
      )
    if (info.changes === 0) return { ok: false, error: '任务不存在' }
    return { ok: true, id: input.id }
  }
  const ins = db
    .prepare(
      `INSERT INTO report_job (name, type, enabled, schedule_kind, interval_sec, daily_time, params, created_at, updated_at)
       VALUES (?, 'chat_sync', ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.name.trim(),
      enabled,
      input.scheduleKind ?? 'manual',
      input.scheduleKind === 'interval' ? Math.floor(Number(input.intervalSec) || 0) : 0,
      input.scheduleKind === 'daily' ? (input.dailyTime ?? '') : '',
      json,
      now,
      now
    )
  return { ok: true, id: Number(ins.lastInsertRowid) }
}

export function removeReportJob(id: number): boolean {
  const db = getDb()
  db.prepare(`DELETE FROM report_cursor WHERE job_id = ?`).run(id)
  db.prepare(`DELETE FROM report_run WHERE job_id = ?`).run(id)
  const info = db.prepare(`DELETE FROM report_job WHERE id = ?`).run(id)
  return info.changes > 0
}

export function setReportJobEnabled(id: number, enabled: boolean): { ok: boolean; error?: string } {
  const row = getDb().prepare(`SELECT * FROM report_job WHERE id = ?`).get(id) as JobRow | undefined
  if (!row) return { ok: false, error: '任务不存在' }
  if (enabled) {
    const p = parseParams(row.params)
    if (!p.accountWxid?.trim()) return { ok: false, error: '任务缺少来源账号,请先编辑补全' }
    const onOther = (
      getDb()
        .prepare(`SELECT id, params FROM report_job WHERE id != ? AND type = ? AND enabled = 1`)
        .all(id, row.type) as JobRow[]
    ).some((x) => parseParams(x.params).accountWxid === p.accountWxid)
    if (onOther) return { ok: false, error: '该账号已有启用的同类型任务,请先停用原任务' }
  }
  const now = Date.now()
  // 启用/停用均清空 next_at,由调度器按当前时间重算
  getDb()
    .prepare(`UPDATE report_job SET enabled = ?, next_at = NULL, updated_at = ? WHERE id = ?`)
    .run(enabled ? 1 : 0, now, id)
  return { ok: true }
}

/** 调度器推进 next_at(仅 enabled 任务使用) */
export function setReportJobNextAt(id: number, nextAt: number | null): void {
  getDb().prepare(`UPDATE report_job SET next_at = ? WHERE id = ?`).run(nextAt, id)
}

/** 到点/手动触发的任务(手动:无论 enabled,只要存在即返回;自动:enabled=1 且到点) */
export function listDueReportJobs(now: number, manualJobId?: number): JobRow[] {
  const db = getDb()
  if (manualJobId !== undefined) {
    return db.prepare(`SELECT * FROM report_job WHERE id = ?`).all(manualJobId) as JobRow[]
  }
  return db
    .prepare(`SELECT * FROM report_job WHERE enabled = 1 AND next_at IS NOT NULL AND next_at <= ?`)
    .all(now) as JobRow[]
}

export function markReportJobRun(id: number, status: string, summary: string, at: number): void {
  getDb()
    .prepare(`UPDATE report_job SET last_status = ?, last_summary = ?, last_at = ? WHERE id = ?`)
    .run(status, summary.slice(0, 500), at, id)
}

/* ── 游标 ── */

export interface JobCursorRow {
  session_wxid: string
  cursor_seq: number
  cursor_ms: number
  last_fetch_at: number | null
  no_msg_at: number | null
}

export function listJobCursors(jobId: number): Map<string, JobCursorRow> {
  const rows = getDb().prepare(`SELECT * FROM report_cursor WHERE job_id = ?`).all(jobId) as Array<{
    session_wxid: string
    cursor_seq: number
    cursor_ms: number
    last_fetch_at: number | null
    no_msg_at: number | null
  }>
  const map = new Map<string, JobCursorRow>()
  for (const r of rows) map.set(r.session_wxid, r)
  return map
}

/** 整轮结束一次性落游标(成功才调);超时未完成会话不推进(下次继续) */
export function saveJobCursors(
  jobId: number,
  cursors: Map<string, { seq: number; ms: number; lastFetch: number }>,
  noMsg: Map<string, number>
): void {
  const db = getDb()
  const upsert = db.prepare(
    `INSERT INTO report_cursor (job_id, session_wxid, cursor_seq, cursor_ms, last_fetch_at, no_msg_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(job_id, session_wxid) DO UPDATE SET
       cursor_seq = excluded.cursor_seq, cursor_ms = excluded.cursor_ms,
       last_fetch_at = excluded.last_fetch_at, no_msg_at = excluded.no_msg_at`
  )
  const touch = db.prepare(
    `UPDATE report_cursor SET last_fetch_at = ? WHERE job_id = ? AND session_wxid = ?`
  )
  const cleanNoMsg = db.prepare(
    `UPDATE report_cursor SET no_msg_at = NULL WHERE job_id = ? AND session_wxid = ?`
  )
  for (const [sid, c] of cursors) {
    if (c.seq > 0 || c.ms > 0 || c.lastFetch > 0)
      upsert.run(jobId, sid, c.seq, c.ms, c.lastFetch, null)
    else touch.run(c.lastFetch, jobId, sid)
  }
  for (const [sid, at] of noMsg) {
    db.prepare(
      `INSERT INTO report_cursor (job_id, session_wxid, cursor_seq, cursor_ms, last_fetch_at, no_msg_at)
       VALUES (?, ?, 0, 0, NULL, ?)
       ON CONFLICT(job_id, session_wxid) DO UPDATE SET no_msg_at = excluded.no_msg_at`
    ).run(jobId, sid, at)
  }
  for (const [sid] of listJobCursors(jobId)) {
    if (!cursors.has(sid) && !noMsg.has(sid)) cleanNoMsg.run(jobId, sid)
  }
}

/* ── 运行历史 ── */

export function insertReportRun(input: {
  jobId: number
  trigger: string
  status: string
  startedAt: number
  added?: number
  sessionsOk?: number
  sessionsSkip?: number
  errors?: string
}): number {
  const info = getDb()
    .prepare(
      `INSERT INTO report_run (job_id, trigger, status, added, sessions_ok, sessions_skip, errors, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.jobId,
      input.trigger,
      input.status,
      input.added ?? 0,
      input.sessionsOk ?? 0,
      input.sessionsSkip ?? 0,
      input.errors?.slice(0, 4000) ?? null,
      input.startedAt
    )
  return Number(info.lastInsertRowid)
}

export function finishReportRun(
  runId: number,
  status: string,
  added: number,
  sessionsOk: number,
  sessionsSkip: number,
  errors: string | undefined,
  endedAt: number
): void {
  const started = getDb().prepare(`SELECT started_at FROM report_run WHERE id = ?`).get(runId) as
    { started_at: number } | undefined
  getDb()
    .prepare(
      `UPDATE report_run SET status = ?, added = ?, sessions_ok = ?, sessions_skip = ?, errors = ?, ended_at = ?, duration_ms = ? WHERE id = ?`
    )
    .run(
      status,
      added,
      sessionsOk,
      sessionsSkip,
      errors?.slice(0, 4000) ?? null,
      endedAt,
      started ? endedAt - started.started_at : null,
      runId
    )
}

export function listReportRuns(jobId: number, limit = 20): ReportRunInfo[] {
  const rows = getDb()
    .prepare(`SELECT * FROM report_run WHERE job_id = ? ORDER BY id DESC LIMIT ?`)
    .all(jobId, limit) as RunRow[]
  return rows.map((r) => ({
    id: r.id,
    jobId: r.job_id,
    trigger: r.trigger,
    status: r.status,
    added: r.added,
    sessionsOk: r.sessions_ok,
    sessionsSkip: r.sessions_skip,
    errors: r.errors ?? undefined,
    startedAt: r.started_at,
    endedAt: r.ended_at ?? undefined,
    durationMs: r.duration_ms ?? undefined
  }))
}

/** 运行历史清理:每个任务保留最近 200 条且不超过 30 天 */
export function cleanOldReportRuns(): void {
  const db = getDb()
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000
  db.prepare(`DELETE FROM report_run WHERE started_at < ?`).run(cutoff)
  const jobs = db.prepare(`SELECT id FROM report_job`).all() as Array<{ id: number }>
  for (const j of jobs) {
    const keep = db
      .prepare(`SELECT id FROM report_run WHERE job_id = ? ORDER BY id DESC LIMIT 200`)
      .all(j.id) as Array<{ id: number }>
    if (keep.length < 200) continue
    const min = keep[keep.length - 1].id
    db.prepare(`DELETE FROM report_run WHERE job_id = ? AND id < ?`).run(j.id, min)
  }
}

export function isAccountJobDuplicate(
  type: string,
  accountWxid: string,
  excludeId?: number
): boolean {
  const rows = getDb()
    .prepare(`SELECT id, params FROM report_job WHERE type = ? AND id != ?`)
    .all(type, excludeId ?? -1) as JobRow[]
  return rows.some((r) => parseParams(r.params).accountWxid === accountWxid)
}
