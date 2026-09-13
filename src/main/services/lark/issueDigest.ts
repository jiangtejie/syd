/**
 * 群问题 → 飞书纯文本摘要（工作台「发到飞书」按钮与 AI 工具 `feishu_send_message` 共用一份口径）。
 *
 * **零依赖纯函数**：时间文案由调用方用共享实现（`fmtStamp`/`fmtTimeShort`）算好传进来 ——
 * 一是保持「全仓时间口径只有一份实现」，二是让本模块能被 `scripts/lark-sync-selftest.mjs` 直接离线导入
 * （带运行时 import 的模块在纯 Node 下跑不起来）。
 */

export interface DigestIssueLite {
  id: number
  title: string
  type: string
  status: string
  severity?: string
  /** 首现时间文案（调用方 `fmtTimeShort(occurAt)`） */
  occurText: string
  followUp?: boolean
  followUpOverdue?: boolean
  assignee?: string
}

const OPEN_STATUS = new Set(['open', 'stalled'])

export function buildGroupIssuesText(input: {
  groupName: string
  /** 发送时刻文案（调用方 `fmtStamp(Date.now())`） */
  nowText: string
  issues: DigestIssueLite[]
  limit?: number
}): string {
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 5), 1), 20)
  const open = input.issues.filter((i) => OPEN_STATUS.has(i.status))
  // 口径与监控页 monitor_summary 一致：待处理=没跟进的，跟进中=跟进了未超时，跟进超时单列
  const pending = open.filter((i) => !i.followUp).length
  const following = open.filter((i) => i.followUp && !i.followUpOverdue).length
  const overdue = open.filter((i) => i.followUpOverdue).length

  const head = [
    `【群问题】${(input.groupName || '').trim() || '(未命名群)'} · ${input.nowText}`,
    open.length === 0
      ? '当前没有未闭环的问题。'
      : `未闭环 ${open.length} 条（待处理 ${pending} · 跟进中 ${following}${overdue > 0 ? ` · 跟进超时 ${overdue}` : ''}）`
  ]
  if (open.length === 0) return head.join('\n')

  const rows = open.slice(0, limit).map((it, idx) => {
    const tags = `${it.severity ? `[${it.severity}]` : ''}${it.type ? `[${it.type}]` : ''}`
    const state = it.followUpOverdue ? '跟进超时' : it.followUp ? '跟进中' : '待处理'
    const meta = [`首现 ${it.occurText}`, state, it.assignee ? `跟进:${it.assignee}` : '']
      .filter(Boolean)
      .join(' · ')
    return `${idx + 1}. ${tags}${it.title}\n   ${meta}`
  })
  if (open.length > limit) rows.push(`…（仅列前 ${limit} 条，共 ${open.length} 条未闭环）`)
  return [...head, '', ...rows].join('\n')
}
