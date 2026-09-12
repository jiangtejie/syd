/**
 * 渲染端通用 UI 工具。
 */

/** 两位数补零：本文件所有时间显示都精确到秒，统一走它 */
const p2 = (n: number): string => String(n).padStart(2, '0')

/** 按名字哈希取稳定配色（头像底色）。
 * 注意：这是头像辨识用的取色板（各色仅用于区分不同会话/联系人），
 * 非品牌/语义色，刻意不收敛为设计 token（含 #07c160，此处不代表品牌绿）。 */
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

/** 会话列表时间：今天 HH:mm:ss，昨天「昨天」，今年 M/D HH:mm:ss，跨年 YYYY/M/D HH:mm:ss（时间一律精确到秒） */
export function formatSessionTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const hh = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
  const dayStart = (x: Date): number =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const dayDiff = Math.round((dayStart(now) - dayStart(d)) / 86400000)
  if (dayDiff <= 0) return hh
  if (dayDiff === 1) return '昨天'
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()} ${hh}`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${hh}`
}

/** 会话摘要预览：取首行并清理多余空白（微信 digest 可能含多行/空行） */
export function previewSummary(summary: string): string {
  const first = String(summary || '').split('\n')[0] || ''
  return first.replace(/\s+/g, ' ').trim()
}

/** 消息时间：当天 HH:mm:ss，否则 M/D HH:mm:ss */
export function formatMessageTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const hh = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
  if (sameDay) return hh
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}`
}

/** 消息时间分隔条：>5 分钟间隔时插入。今天 HH:mm:ss，昨天 昨天 HH:mm:ss，更早 M/D HH:mm:ss，跨年 YYYY/M/D HH:mm:ss */
export function formatTimeDivider(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const hh = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
  const dayStart = (x: Date): number =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
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
