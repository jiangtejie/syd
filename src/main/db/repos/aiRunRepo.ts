import { getDb } from '../database'

/**
 * AI 调用计量（ai_run）读写。
 *
 * 写入**绝不抛**：观测数据落不进去也只是少一行统计，绝不能因此让 AI 调用失败 ——
 * 所以这里所有写路径都吞异常。
 */

export interface AiRunInput {
  module: string
  model: string
  ok: boolean
  /** aborted / timeout / network / http / other */
  errorKind?: string
  /** HTTP 状态码或简短原因（失败 Top 用） */
  errorCode?: string
  latencyMs: number
  /** 实际尝试次数（含首次）：>1 说明发生过重试 */
  attempts: number
  tokensIn?: number
  tokensOut?: number
}

const clip = (s: string | undefined, n: number): string => (s ?? '').slice(0, n)

export function insertAiRun(input: AiRunInput): void {
  try {
    getDb()
      .prepare(
        'INSERT INTO ai_run (at, module, model, ok, error_kind, error_code, latency_ms, attempts, tokens_in, tokens_out)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        Date.now(),
        clip(input.module, 40),
        clip(input.model, 80),
        input.ok ? 1 : 0,
        clip(input.errorKind, 20),
        clip(input.errorCode, 60),
        Math.max(0, Math.round(input.latencyMs || 0)),
        Math.max(1, Math.round(input.attempts || 1)),
        Math.max(0, Math.round(input.tokensIn || 0)),
        Math.max(0, Math.round(input.tokensOut || 0))
      )
  } catch {
    /* 观测失败不影响主流程 */
  }
}

export interface AiRunModuleStat {
  module: string
  total: number
  ok: number
  fail: number
  tokensIn: number
  tokensOut: number
  avgLatencyMs: number
}

export interface AiRunSummary {
  days: number
  total: number
  ok: number
  fail: number
  /** 成功率 0~1（无数据时为 1，避免界面显示成 0% 吓人） */
  okRate: number
  tokensIn: number
  tokensOut: number
  byModule: AiRunModuleStat[]
  topErrors: Array<{ kind: string; code: string; n: number }>
  lastFailures: Array<{ at: number; module: string; errorKind: string; errorCode: string }>
}

/** 近 N 天的调用汇总（面板与排障用） */
export function aiRunSummary(days = 7): AiRunSummary {
  const d = Math.min(90, Math.max(1, Math.floor(days) || 7))
  const since = Date.now() - d * 86_400_000
  const empty: AiRunSummary = {
    days: d,
    total: 0,
    ok: 0,
    fail: 0,
    okRate: 1,
    tokensIn: 0,
    tokensOut: 0,
    byModule: [],
    topErrors: [],
    lastFailures: []
  }
  try {
    const db = getDb()
    const totals = db
      .prepare(
        'SELECT COUNT(*) AS total, COALESCE(SUM(ok),0) AS ok, COALESCE(SUM(tokens_in),0) AS tin, COALESCE(SUM(tokens_out),0) AS tout FROM ai_run WHERE at >= ?'
      )
      .get(since) as { total: number; ok: number; tin: number; tout: number }
    const byModule = db
      .prepare(
        'SELECT module, COUNT(*) AS total, COALESCE(SUM(ok),0) AS ok, COALESCE(SUM(tokens_in),0) AS tin,' +
          ' COALESCE(SUM(tokens_out),0) AS tout, COALESCE(AVG(latency_ms),0) AS lat' +
          ' FROM ai_run WHERE at >= ? GROUP BY module ORDER BY total DESC LIMIT 20'
      )
      .all(since) as Array<{
      module: string
      total: number
      ok: number
      tin: number
      tout: number
      lat: number
    }>
    const topErrors = db
      .prepare(
        'SELECT error_kind AS kind, error_code AS code, COUNT(*) AS n FROM ai_run WHERE at >= ? AND ok = 0 GROUP BY error_kind, error_code ORDER BY n DESC LIMIT 8'
      )
      .all(since) as Array<{ kind: string; code: string; n: number }>
    const lastFailures = db
      .prepare(
        'SELECT at, module, error_kind, error_code FROM ai_run WHERE ok = 0 ORDER BY at DESC LIMIT 10'
      )
      .all() as Array<{ at: number; module: string; error_kind: string; error_code: string }>
    const total = Number(totals?.total ?? 0)
    const ok = Number(totals?.ok ?? 0)
    return {
      days: d,
      total,
      ok,
      fail: total - ok,
      okRate: total > 0 ? ok / total : 1,
      tokensIn: Number(totals?.tin ?? 0),
      tokensOut: Number(totals?.tout ?? 0),
      byModule: byModule.map((r) => ({
        module: String(r.module ?? ''),
        total: Number(r.total ?? 0),
        ok: Number(r.ok ?? 0),
        fail: Number(r.total ?? 0) - Number(r.ok ?? 0),
        tokensIn: Number(r.tin ?? 0),
        tokensOut: Number(r.tout ?? 0),
        avgLatencyMs: Math.round(Number(r.lat ?? 0))
      })),
      topErrors: topErrors.map((r) => ({
        kind: String(r.kind ?? ''),
        code: String(r.code ?? ''),
        n: Number(r.n ?? 0)
      })),
      lastFailures: lastFailures.map((r) => ({
        at: Number(r.at ?? 0),
        module: String(r.module ?? ''),
        errorKind: String(r.error_kind ?? ''),
        errorCode: String(r.error_code ?? '')
      }))
    }
  } catch {
    return empty
  }
}

/** 按保留期清理（与审计表同一套策略；0 = 不清理） */
export function pruneAiRuns(keepDays: number): number {
  const days = Math.max(0, Math.floor(keepDays) || 0)
  if (days === 0) return 0
  try {
    const cutoff = Date.now() - days * 86_400_000
    return Number(getDb().prepare('DELETE FROM ai_run WHERE at < ?').run(cutoff).changes ?? 0)
  } catch {
    return 0
  }
}
