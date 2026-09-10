/**
 * 问题状态文案（AI 工具面与工作台/监控页同口径，避免同一状态在不同入口叫法不一）：
 * - open：疑似 / 待处理 / 跟进中 / 跟进超时（跟进中 = 客服/团队已回复但客户未确认闭环）；
 * - done：标注是否由引擎自动闭环（静默收尾或规则判定）；
 * - archived：区分「人工判定不是问题」(archived_from=open) 与「历史已闭环归档」(done/stalled)——
 *   后者仍计入累计闭环率，只是不再出现在活跃列表。
 */
export function issueStatusLabel(it: {
  status: string
  needConfirm?: boolean
  followUp?: boolean
  followUpOverdue?: boolean
  autoDone?: boolean
  archivedFrom?: string
}): string {
  if (it.status === 'archived') {
    return it.archivedFrom === 'done' || it.archivedFrom === 'stalled'
      ? '已归档(历史已闭环)'
      : '已归档(不是问题)'
  }
  if (it.status === 'done') return `已解决${it.autoDone ? '(自动)' : ''}`
  if (it.status === 'stalled') return '已搁置'
  if (it.needConfirm) return '疑似'
  if (it.followUp) return it.followUpOverdue ? '跟进超时' : '跟进中'
  return '待处理'
}
