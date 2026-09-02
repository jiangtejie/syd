/**
 * 渲染端通用 UI 工具。
 */

/** 按名字哈希取稳定配色（头像底色） */
const AVATAR_COLORS = [
  '#07c160',
  '#1f8ceb',
  '#8a5cf6',
  '#e8833a',
  '#d64f8b',
  '#0fa3a3',
  '#b8860b',
  '#5b7ec9'
]

export function avatarColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}

/** 会话列表时间（对齐微信桌面端）：今天 HH:mm，昨天“昨天”，今年 M/D，跨年 YYYY/M/D */
export function formatSessionTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const hh = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const dayStart = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const dayDiff = Math.round((dayStart(now) - dayStart(d)) / 86400000)
  if (dayDiff <= 0) return hh
  if (dayDiff === 1) return '昨天'
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

/** 会话摘要预览：取首行并清理多余空白（微信 digest 可能含多行/空行） */
export function previewSummary(summary: string): string {
  const first = String(summary || '').split('\n')[0] || ''
  return first.replace(/\s+/g, ' ').trim()
}

/** 消息时间：当天 HH:mm，否则 M/D HH:mm */
export function formatMessageTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const hh = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (sameDay) return hh
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}`
}

/** 消息时间分隔条：>5 分钟间隔时插入。今天 HH:mm，昨天 昨天 HH:mm，更早 M/D HH:mm，跨年 YYYY/M/D HH:mm */
export function formatTimeDivider(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const hh = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const dayStart = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const dayDiff = Math.round((dayStart(now) - dayStart(d)) / 86400000)
  if (dayDiff === 0) return hh
  if (dayDiff === 1) return `昨天 ${hh}`
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()} ${hh}`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${hh}`
}

/** 是否需要在两条消息间插入时间分隔条（间隔 > 5 分钟） */
export function needTimeDivider(prevTs: number, nextTs: number): boolean {
  if (!prevTs) return true
  return nextTs - prevTs > 5 * 60 * 1000
}
