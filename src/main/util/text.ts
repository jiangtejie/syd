/**
 * 主进程文本截断工具。
 *
 * 为什么集中：审计发现全仓有 5 份各自实现的截断（`clip`/`clipText`/`clipForChannel`），
 * 尾部标记与空白处理各不相同（有的是 `…`，有的是 `…(已截断)`；有的折叠空白，有的保留换行）。
 * 这里按**真实使用场景**给四个口径，需要新截断时先看这里有没有合适的，别再写第五份。
 */

/** 单行摘要（列表项、表格单元格）：折叠空白 + 「…」 */
export function clipOneLine(s: string, max: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/** 普通文本：去首尾空白 + 「…」 */
export function clipPlain(s: string, max: number): string {
  const t = (s ?? '').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/** 多行正文（工具输出、错误详情）：保留换行 + 尾注（默认「…(已截断)」） */
export function clipMultiline(s: string, max: number, note = '…(已截断)'): string {
  const t = s ?? ''
  return t.length > max ? `${t.slice(0, max)}\n${note}` : t
}

/** 任意值（非字符串先 JSON.stringify）+ 「…」 */
export function clipValue(v: unknown, max: number): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? '')
  return s.length > max ? s.slice(0, max) + '…' : s
}
