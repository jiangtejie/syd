/**
 * IPC 处理器共用小工具(参数校验 + 统一失败返回)。
 */

/** 整数参数收敛:非有限值回退 fb,否则截断并夹到 [min, max] */
export function clampInt(v: unknown, fb: number, min: number, max: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return fb
  return Math.min(Math.max(Math.trunc(n), min), max)
}

/**
 * 统一失败返回：把任意异常转成 { ok: false, error }。
 * 此前 7 个 handler 文件里逐字重复了 43 段同样的 catch 体。
 */
export function fail(err: unknown, fallback = '操作失败'): { ok: false; error: string } {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  return { ok: false, error: msg || fallback }
}
