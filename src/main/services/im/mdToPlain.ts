/**
 * 模型 Markdown 回复 → 飞书可读纯文本。
 * 桌面端富文本组件(表格/告警块/粗体/引用)语法在飞书纯文本里会原样漏出
 * (如 `| a | b |`、`> [!WARNING]`),回发前做一次轻量降级转换。
 */

const CALLOUT_ICON: Record<string, string> = {
  NOTE: 'ℹ️',
  TIP: '💡',
  IMPORTANT: '❗',
  WARNING: '⚠️',
  DANGER: '🚫'
}

const STOP_WORDS = new Set(['停止', '停', '中止', 'stop', 'halt', 'abort'])

export function isStopCommand(text: string): boolean {
  const t = (text || '').trim().toLowerCase()
  return t.length <= 8 && STOP_WORDS.has(t)
}

/** 轻量 Markdown → 飞书纯文本(行级状态机,无新依赖) */
export function feishuPlainText(md: string): string {
  const src = (md || '').replace(/\r\n/g, '\n')
  const lines = src.split('\n')
  const out: string[] = []
  let fence = false

  const inlineClean = (s: string): string =>
    s
      .replace(/\*\*([^*]+)\*\*/g, '$1') // 粗体
      .replace(/__([^_]+)__/g, '$1') // 粗体备用
      .replace(/`([^`]+)`/g, '$1') // 行内码
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1($2)') // 链接
      .replace(/~~([^~]+)~~/g, '$1')

  for (const raw of lines) {
    const line = raw.replace(/[ \t]+$/, '')
    // 代码块:保留缩进内容,去 ``` 壳
    if (/^\s*(```+|~~~+)/.test(line)) {
      fence = !fence
      out.push(fence ? '【代码】' : '')
      continue
    }
    if (fence) {
      out.push(line.length > 0 ? `  ${line}` : '')
      continue
    }
    const t = line.trim()
    if (!t) {
      out.push('')
      continue
    }
    // 告警块 > [!KIND] …
    const cm = /^>?\s*\[!(NOTE|TIP|IMPORTANT|WARNING|DANGER)\]\s*(.*)$/i.exec(t)
    if (cm) {
      const icon = CALLOUT_ICON[cm[1].toUpperCase()]
      const body = inlineClean(cm[2]).trim()
      out.push(body ? `${icon} ${body}` : icon)
      continue
    }
    // 普通引用
    if (/^>\s?/.test(t)) {
      out.push(`▍${inlineClean(t.replace(/^>\s?/, ''))}`)
      continue
    }
    // 标题
    const hm = /^(#{1,6})\s+(.*)$/.exec(t)
    if (hm) {
      const title = inlineClean(hm[2]).trim()
      const level = hm[1].length
      if (title) out.push(level <= 2 ? `【${title}】` : title)
      continue
    }
    // 分隔线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      out.push('')
      continue
    }
    // 任务清单
    const cb = /^[-*]\s*\[([ xX])\]\s+(.*)$/.exec(t)
    if (cb) {
      const done = cb[1] !== ' ' && cb[1] !== ''
      out.push(`${done ? '☑️' : '⬜'} ${inlineClean(cb[2])}`)
      continue
    }
    // 表格行
    if (/^\|.*\|\s*$/.test(t) && t.split('|').length >= 3) {
      const cells = t
        .replace(/^\|/, '')
        .replace(/\|\s*$/, '')
        .split('|')
        .map((c) => c.trim())
      // 表头分隔行 |---|---|:跳过
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue
      out.push(`· ${cells.map(inlineClean).join(' | ')}`)
      continue
    }
    // 无序列表统一为圆点;有序列表保留
    let final = t
    if (/^[-*]\s+/.test(final)) final = final.replace(/^[-*]\s+/, '• ')
    out.push(inlineClean(final))
  }

  return out
    .join('\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 长文本截断(用户可读,带尾注) */
export function clipForChannel(s: string, max = 200): string {
  const t = (s ?? '').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}
