import type {
  FeedbackIssue,
  FeedbackIssueDetail,
  FeedbackIssueSeverity,
  FeedbackIssueStatus
} from '../../../../shared/types'
import { statusChip } from '../../lib/monitorChips'

/**
 * 监控页的小基元：
 * - KpiCard：HUD 读数格（数字走 .ui-num 等宽 + 状态点 + 危险/警示仅在有值时染淡底）
 * - StatusChip / SeverityChip：状态与严重度统一成全局 ui-chip 语言（表格 / 抽屉同口径）
 * - IssueActions：抽屉底部的处置动作，统一 ui-btn 语气
 */

/** KPI 读数格：label 上方一行小字，value 是主角（等宽数字），hint 降到 --fs-xs */
export function KpiCard({
  label,
  value,
  hint,
  tone
}: {
  label: string
  value: string | number
  hint?: string
  tone?: 'danger' | 'warn' | 'ok'
}): React.JSX.Element {
  // 有值的危险/警示格才染淡底：0 不该整版泛红，读数条要"安静但有层次"
  const text = String(value)
  const hot = text !== '0' && text !== '—' && text !== ''
  return (
    <div className={`mon-kpi${tone ? ` tone-${tone}` : ''}${hot ? ' is-hot' : ''}`}>
      <div className="mon-kpi-label">
        <span className="mon-kpi-dot" aria-hidden="true" />
        {label}
      </div>
      <div className="mon-kpi-value ui-num">{value}</div>
      {hint && (
        <div className="mon-kpi-hint" title={hint}>
          {hint}
        </div>
      )}
    </div>
  )
}

/** 状态语气映射：状态徽标的 is-* 只表达"哪个状态"，语气收敛到 ui-chip 的 ok/warn/bad */
const STATUS_TONE: Record<string, string> = {
  'is-open': 'is-bad',
  'is-overdue': 'is-bad',
  'is-doubt': 'is-warn',
  'is-follow': 'is-warn',
  'is-stalled': 'is-warn',
  'is-done': 'is-ok',
  'is-auto': 'is-ok',
  'is-archived': ''
}

/** 问题状态 chip（待处理 / 跟进中 / 跟进超时 / 疑似 / 已解决 / 已搁置 / 已归档） */
export function StatusChip({
  issue
}: {
  issue: FeedbackIssue | FeedbackIssueDetail
}): React.JSX.Element {
  const chip = statusChip(issue)
  const tone = STATUS_TONE[chip.cls] ?? ''
  return <span className={`ui-chip is-sm mon-status-chip ${tone}`.trim()}>{chip.label}</span>
}

/** 严重度 chip：紧急=危险语气、高=警示语气、一般不出标记（避免每行都挂标签） */
export function SeverityChip({
  severity
}: {
  severity: FeedbackIssueSeverity | undefined
}): React.JSX.Element | null {
  if (!severity || severity === '一般') return null
  return (
    <em className={`ui-chip is-sm mon-sev-chip ${severity === '紧急' ? 'is-bad' : 'is-warn'}`}>
      {severity}
    </em>
  )
}

/** 单条问题状态处置按钮组（抽屉 / 群问题面板复用） */
export function IssueActions({
  issue,
  onSet
}: {
  issue: FeedbackIssue | FeedbackIssueDetail
  onSet: (status: FeedbackIssueStatus) => void
}): React.JSX.Element {
  const st = issue.status
  return (
    <div className="mon-drawer-actions">
      {(st === 'open' || st === 'stalled') && (
        <button type="button" className="ui-btn is-primary is-sm" onClick={() => onSet('done')}>
          ✓ 标记已解决
        </button>
      )}
      {st === 'open' && (
        <>
          <button type="button" className="ui-btn is-ghost is-sm" onClick={() => onSet('stalled')}>
            暂搁置
          </button>
          <button
            type="button"
            className="ui-btn is-ghost is-sm"
            onClick={() => onSet('archived')}
            title="误报/无需处理,归档后不再提醒"
          >
            不是问题
          </button>
        </>
      )}
      {st !== 'open' && (
        <button type="button" className="ui-btn is-ghost is-sm" onClick={() => onSet('open')}>
          ↺ 重新打开
        </button>
      )}
    </div>
  )
}
