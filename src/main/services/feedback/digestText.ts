/**
 * 日报文案渲染（纯函数，零 IO，可自检）。
 *
 * 为什么单独抽出来：日报是**唯一**每天主动出现在管理层眼前的东西，文案里的数字口径必须能单独验证 ——
 * 它错了没人会发现（不像看板点一下就能核对）。
 *
 * 版式约束：手机上要能一眼看完（≤ 20 行）；空的口径直接不出现，避免满屏 0。
 */

export interface DigestItem {
  group: string
  type: string
  title: string
  /** 已等待时长文案，如「2天3小时」 */
  ageText: string
  assignee?: string
}

export interface DigestData {
  /** 展示用日期，如 09-11 */
  dateLabel: string
  /** 昨日新增 */
  created: number
  /** 昨日解决 */
  resolved: number
  /** 当前待处理（不含疑似） */
  open: number
  /** 无人应（客户在等，群里没人回过） */
  noReply: number
  /** 跟进中（有人回过、未闭环） */
  following: number
  /** 跟进超时 */
  overdue: number
  /** 疑似待确认 */
  doubt: number
  /** 积压最久的几条 */
  topBacklog: DigestItem[]
  /** 无人应清单 */
  waiting: DigestItem[]
  /** 按跟进人的在手量 */
  topAssignees: Array<{ name: string; open: number }>
  /** 数字员工昨日表现（影子模式） */
  agent: { total: number; script: number; llm: number; handoff: number; coverage: number } | null
}

/** 等待时长文案：2天3小时 / 5小时20分 / 18分钟 */
export function ageText(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000))
  if (m < 60) return `${m}分钟`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 === 0 ? `${h}小时` : `${h}小时${m % 60}分`
  const d = Math.floor(h / 24)
  const rh = h % 24
  return rh === 0 ? `${d}天` : `${d}天${rh}小时`
}

function itemLine(n: number, it: DigestItem): string {
  const who = it.assignee ? ` · 跟进:${it.assignee}` : ''
  return `${n}. [${it.group || '-'}] ${it.type}·${it.title}（等了 ${it.ageText}）${who}`
}

export function renderDigest(d: DigestData): string {
  const out: string[] = [`📋 群问题日报 · ${d.dateLabel}`]

  const stats: string[] = [`新增 ${d.created}`, `已解决 ${d.resolved}`]
  stats.push(`待处理 ${d.open}`)
  if (d.noReply > 0) stats.push(`其中无人应 ${d.noReply}`)
  if (d.following > 0) stats.push(`跟进中 ${d.following}`)
  if (d.overdue > 0) stats.push(`跟进超时 ${d.overdue}`)
  if (d.doubt > 0) stats.push(`疑似 ${d.doubt}`)
  out.push(stats.join(' · '))

  if (d.topBacklog.length > 0) {
    out.push('', '⏰ 积压最久')
    d.topBacklog.forEach((it, i) => out.push(itemLine(i + 1, it)))
  }

  if (d.waiting.length > 0) {
    out.push('', '🙋 无人应（客户在等）')
    d.waiting.forEach((it, i) => out.push(itemLine(i + 1, it)))
  }

  if (d.topAssignees.length > 0) {
    out.push('', '👤 在手量：' + d.topAssignees.map((a) => `${a.name} ${a.open}`).join(' · '))
  }

  if (d.agent && d.agent.total > 0) {
    const a = d.agent
    out.push(
      '',
      `🤖 数字员工（影子）：命中话术 ${a.script} · 转人工 ${a.handoff} · 未命中 ${a.llm} · 话术覆盖 ${Math.round(a.coverage * 100)}%`
    )
  }

  if (
    d.created + d.resolved + d.open + d.overdue === 0 &&
    d.topBacklog.length === 0 &&
    d.waiting.length === 0 &&
    !d.agent
  ) {
    out.push('', '今天没有待处理问题 ✓')
  }

  out.push('', '打开客服工作台查看详情')
  return out.join('\n')
}
