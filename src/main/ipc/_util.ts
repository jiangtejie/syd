/**
 * 统一失败返回：把任意异常转成 { ok: false, error }。
 * 此前 7 个 handler 文件里逐字重复了 43 段同样的 catch 体。
 */
export function fail(err: unknown, fallback = '操作失败'): { ok: false; error: string } {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  return { ok: false, error: msg || fallback }
}
