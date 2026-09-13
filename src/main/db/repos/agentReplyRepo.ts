import { getDb } from '../database'

/**
 * 数字员工的决策与回复记录（影子模式与实发共用）。
 *
 * 每条都要能回答：依据哪条话术 / 为什么发或没发 / 发出去了没有 / 人工怎么评价。
 * 这是数字员工出事时唯一能复盘的东西，所以宁可多记一列，不要事后猜。
 */

/** 决策来源：script=命中话术；llm=话术未命中、LLM 兜底；handoff=高风险转人工；skip=不介入 */
export type ReplyDecision = 'script' | 'llm' | 'handoff' | 'skip'
/** shadow=只记录；queued=待人工确认；approved=已批准待发；sent=已发送；failed=发送失败；rejected=人工否掉 */
export type ReplyStatus = 'shadow' | 'queued' | 'approved' | 'sent' | 'failed' | 'rejected'

export interface AgentReplyInput {
  accountWxid: string
  groupUsername: string
  groupName?: string
  triggerSeq?: number
  triggerTime?: number
  triggerText?: string
  decision: ReplyDecision
  scriptId?: number
  intent?: string
  /** 意图来源：script/rule/llm/none */
  intentSource?: string
  intentConfidence?: number
  /** 命中词（顿号分隔） */
  intentEvidence?: string
  replyText?: string
  riskLevel?: string
  status?: ReplyStatus
  reason?: string
}

export interface AgentReply {
  id: number
  accountWxid: string
  groupUsername: string
  groupName: string
  triggerSeq?: number
  triggerTime?: number
  triggerText: string
  decision: ReplyDecision
  scriptId?: number
  intent: string
  /** 意图来源：script（命中话术）/rule（规则层）/llm（模型复核）/none（未归类） */
  intentSource: string
  intentConfidence: number
  /** 命中词（顿号分隔），复盘时用来复现判定 */
  intentEvidence: string
  replyText: string
  riskLevel: string
  status: ReplyStatus
  reason: string
  feedback: string
  sentAt?: number
  verifyOk?: number
  error?: string
  createdAt: number
}

interface ReplyRow {
  id: number
  account_wxid: string
  group_username: string
  group_name: string
  trigger_seq: number | null
  trigger_time: number | null
  trigger_text: string
  decision: string
  script_id: number | null
  intent: string
  intent_source: string | null
  intent_confidence: number | null
  intent_evidence: string | null
  reply_text: string
  risk_level: string
  status: string
  reason: string
  feedback: string
  sent_at: number | null
  verify_ok: number | null
  error: string | null
  created_at: number
}

function toReply(r: ReplyRow): AgentReply {
  return {
    id: r.id,
    accountWxid: r.account_wxid,
    groupUsername: r.group_username,
    groupName: r.group_name,
    triggerSeq: r.trigger_seq ?? undefined,
    triggerTime: r.trigger_time ?? undefined,
    triggerText: r.trigger_text,
    decision: (r.decision || 'skip') as ReplyDecision,
    scriptId: r.script_id ?? undefined,
    intent: r.intent,
    intentSource: r.intent_source ?? '',
    intentConfidence: Number(r.intent_confidence ?? 0),
    intentEvidence: r.intent_evidence ?? '',
    replyText: r.reply_text,
    riskLevel: r.risk_level,
    status: (r.status || 'shadow') as ReplyStatus,
    reason: r.reason,
    feedback: r.feedback,
    sentAt: r.sent_at ?? undefined,
    verifyOk: r.verify_ok ?? undefined,
    error: r.error ?? undefined,
    createdAt: r.created_at
  }
}

/**
 * 写一条决策记录。
 * 唯一索引 (group_username, trigger_seq) 保证同一条消息只决策一次（重复扫描直接返回 null）。
 */
export function insertReply(input: AgentReplyInput): number | null {
  const now = Date.now()
  const info = getDb()
    .prepare(
      'INSERT OR IGNORE INTO agent_reply' +
        ' (account_wxid, group_username, group_name, trigger_seq, trigger_time, trigger_text,' +
        '  decision, script_id, intent, intent_source, intent_confidence, intent_evidence,' +
        '  reply_text, risk_level, status, reason, created_at, updated_at)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      input.accountWxid,
      input.groupUsername,
      input.groupName ?? '',
      input.triggerSeq ?? null,
      input.triggerTime ?? null,
      input.triggerText ?? '',
      input.decision,
      input.scriptId ?? null,
      input.intent ?? '',
      input.intentSource ?? '',
      input.intentConfidence ?? 0,
      input.intentEvidence ?? '',
      input.replyText ?? '',
      input.riskLevel ?? 'A',
      input.status ?? 'shadow',
      input.reason ?? '',
      now,
      now
    )
  if (info.changes === 0) return null
  return Number(info.lastInsertRowid)
}

export function listReplies(
  wxid: string,
  opts: { status?: ReplyStatus; group?: string; decision?: ReplyDecision; limit?: number } = {}
): AgentReply[] {
  const where: string[] = ['account_wxid = ?']
  const args: Array<string | number> = [wxid]
  if (opts.status) {
    where.push('status = ?')
    args.push(opts.status)
  }
  if (opts.decision) {
    where.push('decision = ?')
    args.push(opts.decision)
  }
  if (opts.group) {
    where.push('group_username = ?')
    args.push(opts.group)
  }
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 100), 1), 500)
  const rows = getDb()
    .prepare(
      `SELECT * FROM agent_reply WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .all(...args, limit) as ReplyRow[]
  return rows.map(toReply)
}

/** 增量列出「自某时刻以来有变更」的决策记录（外部同步用：推送到飞书多维表格） */
export function listRepliesChangedSince(wxid: string, sinceMs: number, limit = 300): AgentReply[] {
  const rows = getDb()
    .prepare(
      'SELECT * FROM agent_reply WHERE account_wxid = ? AND updated_at > ? ORDER BY id ASC LIMIT ?'
    )
    .all(wxid, sinceMs, limit) as ReplyRow[]
  return rows.map(toReply)
}

export function setReplyStatus(
  id: number,
  status: ReplyStatus,
  extra: { sentAt?: number; verifyOk?: boolean; error?: string } = {}
): void {
  getDb()
    .prepare(
      'UPDATE agent_reply SET status = ?, sent_at = COALESCE(?, sent_at),' +
        ' verify_ok = COALESCE(?, verify_ok), error = ?, updated_at = ? WHERE id = ?'
    )
    .run(
      status,
      extra.sentAt ?? null,
      extra.verifyOk === undefined ? null : extra.verifyOk ? 1 : 0,
      extra.error ?? null,
      Date.now(),
      id
    )
}

/** 人工反馈：good=答得对 / bad=答错 / no-reply=这条根本不该回（反例，供后续优化话术） */
export function setReplyFeedback(id: number, feedback: string): void {
  getDb()
    .prepare('UPDATE agent_reply SET feedback = ?, updated_at = ? WHERE id = ?')
    .run(feedback, Date.now(), id)
}

/** 值班页头部统计：近 N 天的决策分布与话术命中率 */
export function replyStats(
  wxid: string,
  sinceMs: number
): { total: number; script: number; llm: number; handoff: number; noMatchRate: number } {
  const rows = getDb()
    .prepare(
      'SELECT decision, COUNT(*) AS n FROM agent_reply WHERE account_wxid = ? AND created_at >= ? GROUP BY decision'
    )
    .all(wxid, sinceMs) as Array<{ decision: string; n: number }>
  const get = (k: string): number => rows.find((r) => r.decision === k)?.n ?? 0
  const script = get('script')
  const llm = get('llm')
  const handoff = get('handoff')
  const total = rows.reduce((a, b) => a + b.n, 0)
  return {
    total,
    script,
    llm,
    handoff,
    noMatchRate: total > 0 ? 1 - script / total : 0
  }
}

/** 待识别意图的 where 片段：空意图，或上次判成「未归类」（词表升级后可重跑） */
const NEEDS_INTENT_WHERE =
  " (intent IS NULL OR intent = '' OR intent_source IS NULL OR intent_source = '' OR intent_source = 'none')" +
  " AND trigger_text <> ''"

/** 待识别意图的历史记录(补全/重跑动作的数据源):按时间倒序 */
export function listRepliesMissingIntent(limit = 200): AgentReply[] {
  const rows = getDb()
    .prepare('SELECT * FROM agent_reply WHERE' + NEEDS_INTENT_WHERE + ' ORDER BY id DESC LIMIT ?')
    .all(Math.min(Math.max(Math.round(limit), 1), 2000)) as ReplyRow[]
  return rows.map(toReply)
}

/** 待识别的条数(界面按钮上显示「补全 N 条」) */
export function countRepliesMissingIntent(): number {
  const r = getDb()
    .prepare('SELECT COUNT(*) AS c FROM agent_reply WHERE' + NEEDS_INTENT_WHERE)
    .get() as { c: number }
  return Number(r?.c ?? 0)
}

/** 回填一条的意图(只写意图相关列,不动决策与发送状态) */
export function setReplyIntent(
  id: number,
  v: { intent: string; source: string; confidence: number; evidence: string }
): void {
  getDb()
    .prepare(
      'UPDATE agent_reply SET intent = ?, intent_source = ?, intent_confidence = ?,' +
        ' intent_evidence = ?, updated_at = ? WHERE id = ?'
    )
    .run(v.intent, v.source, v.confidence, v.evidence, Date.now(), id)
}

/** 按来源统计意图识别质量(界面用:规则/模型/未归类各多少条) */
export function intentSourceCounts(wxid: string): Array<{ source: string; n: number }> {
  const rows = getDb()
    .prepare(
      'SELECT intent_source AS source, COUNT(*) AS n FROM agent_reply' +
        ' WHERE account_wxid = ? GROUP BY intent_source ORDER BY n DESC'
    )
    .all(wxid) as Array<{ source: string; n: number }>
  return rows.map((r) => ({ source: r.source || 'none', n: Number(r.n ?? 0) }))
}
