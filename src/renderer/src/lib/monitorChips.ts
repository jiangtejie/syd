import type { FeedbackIssue, FeedbackIssueStatus } from '../../../shared/types'

/**
 * 状态徽标文案与配色（表格 / 追踪抽屉同口径）：
 * 疑似桶优先，open 再细分 跟进中 / 跟进超时，done 标注自动闭环。
 */
/** 状态徽标文案与配色（表格/抽屉/群问题面板同口径：疑似优先，跟进中/超时细分） */
const STATUS_CHIP: Record<FeedbackIssueStatus, { label: string; cls: string }> = {
  open: { label: '待处理', cls: 'is-open' },
  done: { label: '已解决', cls: 'is-done' },
  stalled: { label: '已搁置', cls: 'is-stalled' },
  archived: { label: '已归档', cls: 'is-archived' }
}

export function statusChip(it: FeedbackIssue): { label: string; cls: string } {
  // 疑似桶优先展示（不占正式口径文案）
  if (it.needConfirm && it.status === 'open') {
    return { label: '疑似', cls: 'is-doubt' }
  }
  if (it.status === 'open') {
    if (it.followUp) {
      return {
        label: it.followUpOverdue ? '跟进超时' : '跟进中',
        cls: it.followUpOverdue ? 'is-overdue' : 'is-follow'
      }
    }
    return { label: '待处理', cls: 'is-open' }
  }
  if (it.status === 'done' && it.autoDone) {
    return { label: '自动解决', cls: 'is-auto' }
  }
  return STATUS_CHIP[it.status]
}
