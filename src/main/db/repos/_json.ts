/**
 * JSON 列读取共用工具(各域 repos 的 JSON 列解析共用)。
 */

/**
 * 解析 JSON 列:原始值为空/非法时回退 fallback,解析结果为 null 时同样回退。
 * 兼容 string(库列)与 unknown(已解析对象)两种入参。
 */
export function safeJson<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') return fallback
  try {
    const v = JSON.parse(typeof raw === 'string' ? raw : String(raw))
    return (v ?? fallback) as T
  } catch {
    return fallback
  }
}
