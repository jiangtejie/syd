import { getDb } from '../database'

/**
 * 话术库（数字员工的口径）。
 *
 * 设计取舍：**话术优先、LLM 兜底**。话术是权威（口径统一、可审计、可回滚），
 * LLM 只负责理解意图与措辞兜底；否则同一个问题两次答复不一致，比不回更伤客户。
 * patterns 用关键词/正则（确定性），语义匹配留到后续迭代。
 */

export type ScriptPatternType = 'kw' | 're'
export interface ScriptPattern {
  type: ScriptPatternType
  value: string
}

/** 风险等级：A=可自动发；B=需人工确认；C=永不自动（价格/退款/投诉/合同） */
export type RiskLevel = 'A' | 'B' | 'C'

export interface ReplyScript {
  id: number
  accountWxid: string
  intent: string
  title: string
  patterns: ScriptPattern[]
  replyText: string
  riskLevel: RiskLevel
  priority: number
  enabled: boolean
  source: string
  hitCount: number
  lastHitAt?: number
}

export interface ReplyScriptInput {
  id?: number
  accountWxid?: string
  intent: string
  title?: string
  patterns: ScriptPattern[]
  replyText: string
  riskLevel?: RiskLevel
  priority?: number
  enabled?: boolean
  source?: string
}

interface ScriptRow {
  id: number
  account_wxid: string
  intent: string
  title: string
  patterns: string
  reply_text: string
  risk_level: string
  priority: number
  enabled: number
  source: string
  hit_count: number
  last_hit_at: number | null
}

/** 解析 patterns 列：坏值按空数组处理（话术命中不能因为一条脏数据整体崩掉） */
export function parsePatterns(raw: string | null | undefined): ScriptPattern[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw) as unknown
    if (!Array.isArray(v)) return []
    const out: ScriptPattern[] = []
    for (const it of v) {
      const o = it as { type?: unknown; value?: unknown }
      const value = typeof o?.value === 'string' ? o.value.trim() : ''
      if (!value) continue
      out.push({ type: o?.type === 're' ? 're' : 'kw', value })
    }
    return out
  } catch {
    return []
  }
}

function toScript(r: ScriptRow): ReplyScript {
  return {
    id: r.id,
    accountWxid: r.account_wxid,
    intent: r.intent,
    title: r.title,
    patterns: parsePatterns(r.patterns),
    replyText: r.reply_text,
    riskLevel: r.risk_level === 'B' || r.risk_level === 'C' ? r.risk_level : 'A',
    priority: r.priority,
    enabled: !!r.enabled,
    source: r.source,
    hitCount: r.hit_count,
    lastHitAt: r.last_hit_at ?? undefined
  }
}

/** 某账号可用的全部话术（含通用话术 account_wxid=''），按优先级升序 */
export function listScripts(wxid: string, opts: { enabledOnly?: boolean } = {}): ReplyScript[] {
  const sql =
    "SELECT * FROM reply_script WHERE (account_wxid = ? OR account_wxid = '')" +
    (opts.enabledOnly ? ' AND enabled = 1' : '') +
    ' ORDER BY priority ASC, id ASC'
  const rows = getDb().prepare(sql).all(wxid) as ScriptRow[]
  return rows.map(toScript)
}

export function saveScript(input: ReplyScriptInput): number {
  const now = Date.now()
  const db = getDb()
  const account = (input.accountWxid ?? '').trim()
  const intent = (input.intent || '').trim()
  const title = (input.title || intent).trim()
  const patterns = JSON.stringify(input.patterns ?? [])
  const replyText = input.replyText || ''
  const risk: RiskLevel = input.riskLevel === 'B' || input.riskLevel === 'C' ? input.riskLevel : 'A'
  const priority = Number.isFinite(input.priority) ? Number(input.priority) : 100
  if (input.id) {
    db.prepare(
      'UPDATE reply_script SET account_wxid = ?, intent = ?, title = ?, patterns = ?,' +
        ' reply_text = ?, risk_level = ?, priority = ?, enabled = ?, updated_at = ? WHERE id = ?'
    ).run(
      account,
      intent,
      title,
      patterns,
      replyText,
      risk,
      priority,
      input.enabled === false ? 0 : 1,
      now,
      input.id
    )
    return input.id
  }
  const info = db
    .prepare(
      'INSERT INTO reply_script' +
        ' (account_wxid, intent, title, patterns, reply_text, risk_level, priority, enabled, source, created_at, updated_at)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      account,
      intent,
      title,
      patterns,
      replyText,
      risk,
      priority,
      input.enabled === false ? 0 : 1,
      input.source || 'manual',
      now,
      now
    )
  return Number(info.lastInsertRowid)
}

export function removeScript(id: number): boolean {
  return getDb().prepare('DELETE FROM reply_script WHERE id = ?').run(id).changes > 0
}

export function setScriptEnabled(id: number, enabled: boolean): void {
  getDb()
    .prepare('UPDATE reply_script SET enabled = ?, updated_at = ? WHERE id = ?')
    .run(enabled ? 1 : 0, Date.now(), id)
}

/** 命中计数（影子模式也计：用来判断哪些话术真被需要、哪些该删） */
export function bumpScriptHit(id: number): void {
  getDb()
    .prepare('UPDATE reply_script SET hit_count = hit_count + 1, last_hit_at = ? WHERE id = ?')
    .run(Date.now(), id)
}

/** 批量导入：按 (账号 + intent) 覆盖更新，不存在则新增；返回统计 */
export function importScripts(
  wxid: string,
  rows: ReplyScriptInput[]
): { inserted: number; updated: number; skipped: number } {
  const db = getDb()
  let inserted = 0
  let updated = 0
  let skipped = 0
  const run = db.transaction(() => {
    for (const r of rows) {
      const intent = (r.intent || '').trim()
      if (!intent || !r.replyText) {
        skipped++
        continue
      }
      const exist = db
        .prepare('SELECT id FROM reply_script WHERE account_wxid = ? AND intent = ?')
        .get((r.accountWxid ?? wxid).trim(), intent) as { id: number } | undefined
      if (exist) {
        saveScript({ ...r, id: exist.id, accountWxid: r.accountWxid ?? wxid, intent })
        updated++
      } else {
        saveScript({ ...r, accountWxid: r.accountWxid ?? wxid, intent })
        inserted++
      }
    }
  })
  run()
  return { inserted, updated, skipped }
}
