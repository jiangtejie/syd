/**
 * Base 写入的字段解析（**纯函数，零依赖**，可离线自检）。
 *
 * 为什么单独成文件：写入是「模型给的 JSON 字符串 → 飞书字段对象」这一步，
 * 形状错了会直接 400 或写坏数据；这里把校验规则钉死并进自检（字段数上限、必须是对象、键不能为空）。
 */

export interface ParsedRecordFields {
  ok: true
  fields: Record<string, unknown>
}
export interface ParseRecordFieldsError {
  ok: false
  error: string
}

/** 单次写入的字段数上限（防模型一次性塞一个超大对象） */
export const MAX_WRITE_FIELDS = 40

export function parseRecordFields(input: string): ParsedRecordFields | ParseRecordFieldsError {
  const raw = (input ?? '').trim()
  if (!raw) {
    return {
      ok: false,
      error:
        '缺少 fields：请给一个 JSON 对象，例如 {"标题":"孜然粉到货","状态":"跟进中"}（列名用表里的原列名）。'
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return {
      ok: false,
      error: `fields 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'fields 必须是 JSON 对象（{}），不能是数组或标量。' }
  }
  const src = parsed as Record<string, unknown>
  const fields: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(src)) {
    const key = k.trim()
    if (!key) continue
    if (v === undefined) continue
    fields[key] = v
  }
  const names = Object.keys(fields)
  if (names.length === 0) return { ok: false, error: 'fields 里没有任何有效列（键不能为空）。' }
  if (names.length > MAX_WRITE_FIELDS) {
    return {
      ok: false,
      error: `一次最多写 ${MAX_WRITE_FIELDS} 列（当前 ${names.length} 列），请分批。`
    }
  }
  return { ok: true, fields }
}
