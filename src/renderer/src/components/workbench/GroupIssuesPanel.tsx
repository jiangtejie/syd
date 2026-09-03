import { useEffect, useMemo, useState } from 'react'
import { useWorkbenchStore } from '../../stores/workbench'
import type {
  FeedbackIssue,
  FeedbackIssueDetail,
  FeedbackIssueStatus
} from '../../../../shared/types'

/**
 * 群问题面板（右栏「群问题」视图，仅群会话展示）。
 * 数据：issue_feedback（与看板同源同状态）。
 * 交互：表格列出该群待运营问题 → 点行展开「证据消息时间线」（首现 → 最新）
 *       → 状态流转 open/done/stalled（已解决可重新打开），处理结果与看板同步。
 */

const STATUS_LABEL: Record<FeedbackIssueStatus, string> = {
  open: '待处理',
  done: '已解决',
  stalled: '已搁置',
  archived: '已归档'
}

const DAYS_OPTIONS = [1, 2, 3, 7]

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const sameDay = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (sameDay(d, now)) return `今天 ${hhmm}`
  const yest = new Date(now.getTime() - 86_400_000)
  if (sameDay(d, yest)) return `昨天 ${hhmm}`
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hhmm}`
}

/** 面板头部动作按钮（展开区内） */
function StatusActions({
  issue,
  compact
}: {
  issue: FeedbackIssue | FeedbackIssueDetail
  compact?: boolean
}): React.JSX.Element {
  const setStatus = useWorkbenchStore((s) => s.setGroupIssueStatus)
  const st = issue.status
  const act = (status: FeedbackIssueStatus): void => {
    void setStatus(issue.id, status)
  }
  return (
    <div className={`gip-actions${compact ? ' is-compact' : ''}`}>
      {(st === 'open' || st === 'stalled') && (
        <button type="button" className="gip-btn primary" onClick={() => act('done')}>
          ✓ 标记已解决
        </button>
      )}
      {st === 'open' && (
        <button type="button" className="gip-btn" onClick={() => act('stalled')}>
          暂搁置
        </button>
      )}
      {(st === 'done' || st === 'stalled' || st === 'archived') && (
        <button type="button" className="gip-btn" onClick={() => act('open')}>
          ↺ 重新打开
        </button>
      )}
    </div>
  )
}

/** 展开详情：摘要 + 证据消息时间线（问题从始至终） */
function IssueTimeline({
  detail,
  issue
}: {
  detail: FeedbackIssueDetail | null
  issue: FeedbackIssue
}): React.JSX.Element {
  const msgs = detail?.related ?? []
  return (
    <div className="gip-detail">
      {issue.summary && <div className="gip-summary">{issue.summary}</div>}
      <div className="gip-tl-caption">
        问题过程 · {msgs.length} 条消息
        <span className="gip-method">{issue.method === 'llm' ? 'AI 提炼' : '规则匹配'}</span>
        {issue.occurAt ? <span className="gip-when">首现 {fmtTime(issue.occurAt)}</span> : null}
      </div>
      <div className="gip-tl">
        {msgs.length === 0 && <div className="gip-empty">无关联消息记录</div>}
        {msgs.map((m, i) => (
          <div key={i} className={`gip-tl-item${m.isSend ? ' is-my' : ''}`}>
            <span className="gip-tl-dot" />
            <div className="gip-tl-body">
              <div className="gip-tl-head">
                <b>{m.isSend ? `我方 · ${m.senderName}` : m.senderName}</b>
                <time>{fmtTime(m.time)}</time>
                {i === 0 && <em className="gip-tag-mark">首现</em>}
                {i === msgs.length - 1 && msgs.length > 1 && <em className="gip-tag-mark">最新</em>}
              </div>
              <div className="gip-tl-text">{m.text || '[非文本消息]'}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="gip-detail-foot">
        <StatusActions issue={detail ?? issue} />
        <span className="gip-sync">处理结果与看板「问题反馈」同步</span>
      </div>
    </div>
  )
}

function GroupIssuesPanel(): React.JSX.Element {
  const issues = useWorkbenchStore((s) => s.groupIssues)
  const loading = useWorkbenchStore((s) => s.groupIssueLoading)
  const analyzing = useWorkbenchStore((s) => s.groupAnalyzing)
  const error = useWorkbenchStore((s) => s.groupIssueError)
  const analyzedAt = useWorkbenchStore((s) => s.groupAnalyzedAt)
  const days = useWorkbenchStore((s) => s.groupDays)
  const setDays = useWorkbenchStore((s) => s.setGroupDays)
  const activeDetail = useWorkbenchStore((s) => s.groupActiveDetail)
  const detailLoading = useWorkbenchStore((s) => s.groupDetailLoading)
  const analyzeNow = useWorkbenchStore((s) => s.analyzeGroupNow)
  const openDetail = useWorkbenchStore((s) => s.openGroupIssue)
  const [expandedId, setExpandedId] = useState<number | null>(null)

  // 切换会话时收起展开态（防旧展开行错位到新群）
  const activeSessionId = useWorkbenchStore((s) => s.activeSessionId)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 会话切换时同步复位 UI（全仓同款模式）
    setExpandedId(null)
  }, [activeSessionId])

  const counts = useMemo(() => {
    const open = issues.filter((i) => i.status === 'open').length
    const done = issues.filter((i) => i.status === 'done').length
    const stalled = issues.filter((i) => i.status === 'stalled').length
    return { open, done, stalled, all: issues.length }
  }, [issues])

  const toggle = (id: number): void => {
    const next = expandedId === id ? null : id
    setExpandedId(next)
    if (next) void openDetail(next)
    else void openDetail(null)
  }

  const methodHint = issues.find((i) => i.method === 'llm')
    ? 'AI 提炼'
    : issues.find((i) => i.method === 'rule')
      ? '规则匹配'
      : ''

  return (
    <div className="gip">
      {/* 头部：窗口 + 重新分析 */}
      <div className="gip-head">
        <div className="gip-head-line">
          <span className="gip-title">本群问题</span>
          <span className="gip-days-tag">近 {days} 天</span>
        </div>
        <div className="gip-tools">
          <select
            className="gip-select"
            value={days}
            title="分析窗口（自然日）：切窗后立即按新窗口重新分析"
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {DAYS_OPTIONS.map((d) => (
              <option key={d} value={d}>
                近 {d} 天
              </option>
            ))}
          </select>
          <button
            type="button"
            className="gip-btn ghost"
            disabled={analyzing}
            onClick={() => void analyzeNow()}
          >
            {analyzing ? '分析中…' : '重新分析'}
          </button>
        </div>
      </div>

      {/* 统计 */}
      <div className="gip-stats">
        <span className="gip-stat is-open">待处理 {counts.open}</span>
        <span className="gip-stat is-done">已解决 {counts.done}</span>
        {counts.stalled > 0 && <span className="gip-stat is-stalled">已搁置 {counts.stalled}</span>}
        <span className="gip-stat">共 {counts.all}</span>
        {(analyzedAt || methodHint) && (
          <span className="gip-meta">
            {analyzedAt ? `${fmtTime(analyzedAt)} · ` : ''}
            {methodHint}
          </span>
        )}
      </div>

      {/* 提示与错误 */}
      {analyzing && <div className="gip-busy">正在提炼近 {days} 天消息中的问题…</div>}
      {!analyzing && error && (
        <div className="gip-error">
          <span>{error}</span>
        </div>
      )}

      {/* 空态 */}
      {!loading && !analyzing && issues.length === 0 && (
        <div className="gip-empty-box">
          {error ? (
            <span>分析未完成，请点击「重新分析」重试</span>
          ) : analyzedAt ? (
            <span>近 {days} 天未发现需要处理的问题 ✓</span>
          ) : (
            <span>点击「重新分析」提炼本群近 {days} 天的待处理问题</span>
          )}
        </div>
      )}

      {/* 问题表格 */}
      {issues.length > 0 && (
        <div className="gip-table">
          <div className="gip-tr gip-th">
            <span className="gip-cell-st">状态</span>
            <span className="gip-cell-main">问题（点击展开完整过程）</span>
            <span className="gip-cell-x">展开</span>
          </div>
          {issues.map((it) => {
            const expanded = expandedId === it.id
            const detail = activeDetail && activeDetail.id === it.id ? activeDetail : null
            return (
              <div key={it.id}>
                <div
                  className={`gip-tr gip-row${expanded ? ' is-expanded' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => toggle(it.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      toggle(it.id)
                    }
                  }}
                >
                  <span className={`gip-cell-st gip-st is-${it.status}`}>
                    {STATUS_LABEL[it.status] ?? it.status}
                  </span>
                  <span className="gip-cell-main">
                    <span className="gip-title-line">
                      <i className={`gip-type t-${it.type}`}>{it.type}</i>
                      <b>{it.title}</b>
                    </span>
                    <span className="gip-sub-line">
                      首现 {fmtTime(it.occurAt)} · 证据 {it.msgCount} 条
                      {it.method === 'llm' ? ' · AI 提炼' : ' · 规则'}
                    </span>
                  </span>
                  <span className="gip-cell-x gip-caret">{expanded ? '▾' : '▸'}</span>
                </div>
                {expanded && (
                  <div className="gip-detail-wrap">
                    {detailLoading && !detail ? (
                      <div className="gip-empty-box">加载证据中…</div>
                    ) : (
                      <IssueTimeline detail={detail} issue={it} />
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {loading && <div className="gip-empty-box">加载中…</div>}
    </div>
  )
}

export default GroupIssuesPanel
