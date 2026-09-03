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
 * 结构：待处理(open) 为主列表；已处理(done/stalled) 与 已忽略/归档(archived) 各自折叠收纳。
 * 交互：点行展开证据时间线（首现→最新）；处理/重开/搁置/误报忽略；自动闭环(检测到客服回复)有徽标；
 *      可从展开区一键「在聊天中定位」。
 */

const STATUS_LABEL: Record<FeedbackIssueStatus, string> = {
  open: '待处理',
  done: '已解决',
  stalled: '已搁置',
  archived: '已归档'
}

const DAYS_OPTIONS = [1, 2, 3, 7]
const DAYS_KEY = 'cs.gipDays'

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

/** 展开区状态操作 */
function StatusActions({ issue }: { issue: FeedbackIssue | FeedbackIssueDetail }): React.JSX.Element {
  const setStatus = useWorkbenchStore((s) => s.setGroupIssueStatus)
  const st = issue.status
  const act = (status: FeedbackIssueStatus): void => {
    void setStatus(issue.id, status)
  }
  return (
    <div className="gip-actions">
      {(st === 'open' || st === 'stalled') && (
        <button type="button" className="gip-btn primary" onClick={() => act('done')}>
          ✓ 标记已解决
        </button>
      )}
      {st === 'open' && (
        <>
          <button type="button" className="gip-btn" onClick={() => act('stalled')}>
            暂搁置
          </button>
          <button
            type="button"
            className="gip-btn ghost"
            title="误报/无需处理：归档后同一问题不再提醒"
            onClick={() => act('archived')}
          >
            不是问题
          </button>
        </>
      )}
      {(st === 'done' || st === 'stalled' || st === 'archived') && (
        <button type="button" className="gip-btn" onClick={() => act('open')}>
          ↺ 重新打开
        </button>
      )}
    </div>
  )
}

/** 展开详情：摘要 + 证据时间线 + 状态说明与操作 */
function IssueTimeline({
  detail,
  issue,
  onLocate
}: {
  detail: FeedbackIssueDetail | null
  issue: FeedbackIssue
  onLocate: (ts: number) => void
}): React.JSX.Element {
  const msgs = detail?.related ?? []
  const cur = detail ?? issue
  return (
    <div className="gip-detail">
      {cur.summary && <div className="gip-summary">{cur.summary}</div>}
      <div className="gip-tl-caption">
        问题过程 · {msgs.length} 条消息
        <span className="gip-method">{cur.method === 'llm' ? 'AI 提炼' : '规则匹配'}</span>
        {cur.occurAt ? <span className="gip-when">首现 {fmtTime(cur.occurAt)}</span> : null}
      </div>
      <div className="gip-tl">
        {msgs.length === 0 && <div className="gip-empty">无关联消息记录</div>}
        {msgs.map((m, i) => (
          <div key={i} className={`gip-tl-item${m.isSend || m.senderIsTeam ? ' is-my' : ''}`}>
            <span className="gip-tl-dot" />
            <div className="gip-tl-body">
              <div className="gip-tl-head">
                <b>
                  {m.isSend ? `我方 · ${m.senderName}` : m.senderIsTeam ? `团队 · ${m.senderName}` : m.senderName}
                </b>
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
        <StatusActions issue={cur} />
        <button
          type="button"
          className="gip-btn ghost"
          onClick={() => onLocate(cur.occurAt)}
          title="切到该群聊天并滚动到问题发生时间附近"
        >
          ◎ 在聊天中定位
        </button>
        <span className="gip-sync">
          {cur.autoDone && cur.status === 'done'
            ? '系统判定已闭环，自动关闭（可重新打开复核）'
            : cur.status === 'open' && cur.followUp
              ? cur.followUpOverdue
                ? '客服回复已超 12 小时未闭环，建议主动跟进'
                : '客服已介入回复，客户未确认闭环 —— 确认处理后请标记已解决'
              : '处理结果与看板「问题反馈」同步'}
        </span>
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
  const locateIssueAt = useWorkbenchStore((s) => s.locateIssueAt)
  const activeSessionId = useWorkbenchStore((s) => s.activeSessionId)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [collapsed, setCollapsed] = useState<{ history: boolean; ignored: boolean }>({
    history: true,
    ignored: true
  })

  // 切换会话时收起展开态（防旧展开行错位到新群）
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 会话切换时同步复位 UI（全仓同款模式）
    setExpandedId(null)
  }, [activeSessionId])

  // 记忆分析窗口（localStorage），首次挂载与已记忆值不同步时生效
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(DAYS_KEY))
      if (Number.isInteger(saved) && saved >= 1 && saved <= 7 && saved !== days) {
        setDays(saved)
      }
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const groups = useMemo(() => {
    const open: FeedbackIssue[] = []
    const history: FeedbackIssue[] = []
    const ignored: FeedbackIssue[] = []
    for (const it of issues) {
      if (it.status === 'open') open.push(it)
      else if (it.status === 'archived') ignored.push(it)
      else history.push(it)
    }
    return { open, history, ignored }
  }, [issues])

  const toggle = (id: number): void => {
    const next = expandedId === id ? null : id
    setExpandedId(next)
    if (next) void openDetail(next)
    else void openDetail(null)
  }

  /** 「重新分析」= 重算本群:有待处理时先确认是否清空重建(避免旧结果累加) */
  const onReanalyze = (): void => {
    if (analyzing) return
    const openCount = issues.filter((i) => i.status === 'open').length
    if (openCount > 0) {
      const ok = window.confirm(
        `将先清空本群 ${openCount} 条待处理/跟进中记录(含证据),再按近 ${days} 天重新提取。\n已解决、已搁置与已归档的历史记录会保留。继续?`
      )
      if (!ok) return
      void analyzeNow({ reset: true })
    } else {
      void analyzeNow()
    }
  }

  const locate = (ts: number): void => {
    if (activeSessionId) void locateIssueAt(activeSessionId, ts)
  }

  const methodHint = issues.find((i) => i.method === 'llm')
    ? 'AI 提炼'
    : issues.find((i) => i.method === 'rule')
      ? '规则匹配'
      : ''

  /** 单组问题列表（行 + 展开详情） */
  const renderList = (rows: FeedbackIssue[], stateLabel: string): React.JSX.Element => (
    <div className="gip-table">
      <div className="gip-tr gip-th">
        <span className="gip-cell-st">{stateLabel}</span>
        <span className="gip-cell-main">问题（点击展开完整过程）</span>
        <span className="gip-cell-x">展开</span>
      </div>
      {rows.map((it) => {
        const expanded = expandedId === it.id
        const detail = activeDetail && activeDetail.id === it.id ? activeDetail : null
        // 状态文案：open 区分 待处理/跟进中/跟进超时；done+autoDone=自动解决
        const isOpen = it.status === 'open'
        const stLabel = isOpen
          ? it.followUp
            ? it.followUpOverdue
              ? '跟进超时'
              : '跟进中'
            : '待处理'
          : it.status === 'done' && it.autoDone
            ? '自动解决'
            : (STATUS_LABEL[it.status] ?? it.status)
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
              <span
                className={`gip-cell-st gip-st ${isOpen && it.followUp ? 'is-follow' : `is-${it.status}`}`}
              >
                {stLabel}
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
                  <IssueTimeline detail={detail} issue={it} onLocate={locate} />
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )

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
            onChange={(e) => {
              const d = Number(e.target.value)
              setDays(d)
              try {
                localStorage.setItem(DAYS_KEY, String(d))
              } catch {
                /* ignore */
              }
            }}
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
            onClick={onReanalyze}
            title="重算本群问题:清空待处理记录后按当前窗口重新分析(历史已解决/归档保留)"
          >
            {analyzing ? '分析中…' : '重新分析'}
          </button>
        </div>
      </div>

      {/* 统计 */}
      <div className="gip-stats">
        <span className="gip-stat is-open">
          待处理 {issues.filter((i) => i.status === 'open' && !i.followUp).length}
        </span>
        <span className="gip-stat is-follow">
          跟进中 {issues.filter((i) => i.status === 'open' && i.followUp).length}
        </span>
        <span className="gip-stat is-done">
          已解决 {issues.filter((i) => i.status === 'done').length}
        </span>
        {groups.history.some((i) => i.status === 'stalled') && (
          <span className="gip-stat is-stalled">
            已搁置 {groups.history.filter((i) => i.status === 'stalled').length}
          </span>
        )}
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

      {/* 待处理组 */}
      {groups.open.length > 0 && renderList(groups.open, '状态')}

      {/* 已处理（折叠） */}
      {groups.history.length > 0 && (
        <div className="gip-fold">
          <button
            type="button"
            className="gip-fold-btn"
            onClick={() => setCollapsed((c) => ({ ...c, history: !c.history }))}
          >
            <span>
              已处理（{groups.history.length}）
            </span>
            <span className="gip-caret">{collapsed.history ? '▸' : '▾'}</span>
          </button>
          {!collapsed.history && renderList(groups.history, '状态')}
        </div>
      )}

      {/* 已忽略/归档（折叠） */}
      {groups.ignored.length > 0 && (
        <div className="gip-fold">
          <button
            type="button"
            className="gip-fold-btn"
            onClick={() => setCollapsed((c) => ({ ...c, ignored: !c.ignored }))}
          >
            <span>已忽略 / 归档（{groups.ignored.length}）</span>
            <span className="gip-caret">{collapsed.ignored ? '▸' : '▾'}</span>
          </button>
          {!collapsed.ignored && renderList(groups.ignored, '状态')}
        </div>
      )}

      {loading && <div className="gip-empty-box">加载中…</div>}
    </div>
  )
}

export default GroupIssuesPanel
