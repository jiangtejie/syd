import { ResolveError } from './collector/resolver'

/** 入库异常 → 用户可读原因(解析失败/网络失败归一化) */
export function errText(e: unknown): string {
  if (e instanceof ResolveError) return e.message
  if (e instanceof Error) {
    const m = e.message
    if (/fetch failed|ENOTFOUND|ECONNREFUSED|timeout|abort/i.test(m)) {
      return '网络请求失败: 请检查网络后重试'
    }
    return m.slice(0, 200)
  }
  return String(e).slice(0, 200)
}
