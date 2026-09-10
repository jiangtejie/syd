import type {
  FeedbackIssue,
  FeedbackIssueDetail,
  FeedbackIssueStatus
} from '../../../../shared/types'

/** KPI 大卡（监控中心顶部指标带） */
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
  return (
    <div className={`mon-kpi${tone ? ` tone-${tone}` : ''}`}>
      <div className="mon-kpi-label">{label}</div>
      <div className="mon-kpi-value">{value}</div>
      {hint && <div className="mon-kpi-hint">{hint}</div>}
    </div>
  )
}

/** 单条问题状态处置按钮组 */
export function IssueActions({
  issue,
  onSet
}: {
  issue: FeedbackIssue | FeedbackIssueDetail
  onSet: (status: FeedbackIssueStatus) => void
}): React.JSX.Element {
  const st = issue.status
  return (
    <div className="mon-actions">
      {(st === 'open' || st === 'stalled') && (
        <button type="button" className="mon-btn primary" onClick={() => onSet('done')}>
          ✓ 标记已解决
        </button>
      )}
      {st === 'open' && (
        <>
          <button type="button" className="mon-btn" onClick={() => onSet('stalled')}>
            暂搁置
          </button>
          <button
            type="button"
            className="mon-btn"
            onClick={() => onSet('archived')}
            title="误报/无需处理,归档后不再提醒"
          >
            不是问题
          </button>
        </>
      )}
      {st !== 'open' && (
        <button type="button" className="mon-btn" onClick={() => onSet('open')}>
          ↺ 重新打开
        </button>
      )}
    </div>
  )
}
