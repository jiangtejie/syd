import { getDb } from '../database'

/** app_config 通用 KV 读写（门控阈值 / 频控 / 时段窗口 / 自动总开关） */
export function getConfig(key: string): string | null {
  const row = getDb().prepare(`SELECT value FROM app_config WHERE key = ?`).get(key) as
    { value: string } | undefined
  return row ? row.value : null
}

export function setConfig(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO app_config (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, value)
}

export function getConfigNumber(key: string, fallback: number): number {
  const v = getConfig(key)
  if (v === null || v === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

export function getConfigBoolean(key: string, fallback: boolean): boolean {
  const v = getConfig(key)
  if (v === null || v === '') return fallback
  return v === 'true' || v === '1'
}

export function getAllConfig(): Record<string, string> {
  const rows = getDb().prepare(`SELECT key, value FROM app_config`).all() as Array<{
    key: string
    value: string
  }>
  const out: Record<string, string> = {}
  for (const r of rows) out[r.key] = r.value
  return out
}
