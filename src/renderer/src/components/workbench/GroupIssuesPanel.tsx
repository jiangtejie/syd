import { useEffect, useMemo, useState } from 'react'
import { useWorkbenchStore } from '../../stores/workbench'
import { confirmAsk } from '../../stores/confirmDialog'
import { useTeamNames } from '../../lib/teamNames'
import { TeamMarkButton } from '../TeamMarkButton'
import type {
  FeedbackIssue,
  FeedbackIssueDetail,
  FeedbackIssueStatus,
  TeamMemberInfo
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
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (sameDay(d, now)) return `今天 ${hhmm}`
  const yest = new Date(now.getTime() - 86_400_000)
  if (sameDay(d, yest)) return `昨天 ${hhmm}`
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hhmm}`
}

/** 展开区：跟进人指派（团队成员；空 = 未指派） */
function OwnerPicker({
  issue,
  members,
  nameOf
}: {
  issue: FeedbackIssue | FeedbackIssueDetail
  members: TeamMemberInfo[]
  nameOf: (u?: string) => string
}): React.JSX.Element {
  const assign = useWorkbenchStore((s) => s.assignGroupIssue)
  return (
    <label className="gip-owner" title="指派/更换跟进人（团队成员，空 = 取消指派）">
      <span className="gip-owner-label">跟进人</span>
      <select
        className="gip-select gip-owner-select"
        value={issue.assignee ?? ''}
        onChange={(e) => void assign(issue.id, e.target.value || null)}
      >
        <option value="">未指派</option>
        {members.map((m) => (
          <option key={m.username} value={m.username}>
            {nameOf(m.username)}
          </option>
        ))}
      </select>
      {members.length === 0 && (
        <span className="gip-owner-hint">
          暂无团队成员：对话页右键消息「标记为团队客服」后可指派
        </span>
      )}
    </label>
  )
}

/** 展开区状态操作 */
function StatusActions({
  issue
}: {
  issue: FeedbackIssue | FeedbackIssueDetail
}): React.JSX.Element {
  const setStatus = useWorkbenchStore((s) => s.setGroupIssueStatus)
  const confirmIssue = useWorkbenchStore((s) => s.confirmGroupIssue)
  const st = issue.status
  const act = (status: FeedbackIssueStatus): void => {
    void setStatus(issue.id, status)
  }
  return (
    <div className="gip-actions">
      {issue.needConfirm && st === 'open' && (
        <button
          type="button"
          className="gip-btn primary"
          title="核实为真实问题：移出疑似桶并计入正式待办"
          onClick={() => void confirmIssue(issue.id)}
        >
          ✓ 核实为真问题
        </button>
      )}
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
  onLocate,
  members,
  nameOf,
  wxid,
  teamUsernames,
  onMarkTeam
}: {
  detail: FeedbackIssueDetail | null
  issue: FeedbackIssue
  onLocate: (ts: number) => void
  members: TeamMemberInfo[]
  nameOf: (u?: string) => string
  wxid: string
  teamUsernames: string[]
  onMarkTeam: () => void
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
                  {m.isSend
                    ? `我方 · ${m.senderName}`
                    : m.senderIsTeam
                      ? `团队 · ${m.senderName}`
                      : m.senderName}
                </b>
                {!m.isSend && !m.senderIsTeam && (
                  <TeamMarkButton
                    wxid={wxid}
                    username={m.senderUsername}
                    displayName={m.senderName}
                    marked={!!m.senderUsername && teamUsernames.includes(m.senderUsername)}
                    onMarked={onMarkTeam}
                  />
                )}
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
        <OwnerPicker issue={cur} members={members} nameOf={nameOf} />
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
  const coverage = useWorkbenchStore((s) => s.groupCoverage)
  const setDays = useWorkbenchStore((s) => s.setGroupDays)
  const activeDetail = useWorkbenchStore((s) => s.groupActiveDetail)
  const detailLoading = useWorkbenchStore((s) => s.groupDetailLoading)
  const analyzeNow = useWorkbenchStore((s) => s.analyzeGroupNow)
  const clearGroupAll = useWorkbenchStore((s) => s.clearGroupAll)
  const openDetail = useWorkbenchStore((s) => s.openGroupIssue)
  const locateIssueAt = useWorkbenchStore((s) => s.locateIssueAt)
  const activeSessionId = useWorkbenchStore((s) => s.activeSessionId)
  const wxid = useWorkbenchStore((s) => s.wxid)
  const assignIssue = useWorkbenchStore((s) => s.assignGroupIssue)
  const [teamReloadKey, setTeamReloadKey] = useState(0)
  const { members, nameOf } = useTeamNames(wxid, teamReloadKey)
  const teamUsernames = useMemo(() => members.map((m) => m.username), [members])
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
    const doubt: FeedbackIssue[] = []
    const history: FeedbackIssue[] = []
    const ignored: FeedbackIssue[] = []
    for (const it of issues) {
      if (it.status === 'open' && it.needConfirm) {
        doubt.push(it)
      } else if (it.status === 'open') {
        open.push(it)
      } else if (it.status === 'archived') {
        ignored.push(it)
      } else {
        history.push(it)
      }
    }
    return { open, doubt, history, ignored }
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
      void confirmAsk({
        title: '重新分析本群',
        message: `将先清空本群 ${openCount} 条待处理/跟进中记录(含证据),再按近 ${days} 天重新提取。已解决、已搁置与已归档的历史记录会保留。`,
        confirmText: '清空并重析',
        danger: true
      }).then((ok) => {
        if (ok) void analyzeNow({ reset: true })
      })
    } else {
      void analyzeNow()
    }
  }

  /** 「清空本群」:删除该群全部记录并自动重新提取(含历史,不可恢复) */
  const onClearAll = (): void => {
    if (analyzing) return
    void confirmAsk({
      title: '清空本群记录',
      message: `将删除本群全部问题记录(共 ${issues.length} 条,含已解决/已归档与证据消息),此操作不可恢复。确认后将立即按近 ${days} 天从零重新分析提取。`,
      confirmText: '清空并重析',
      danger: true
    }).then((ok) => {
      if (ok) void clearGroupAll()
    })
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
        // 状态文案：open 区分 待处理/跟进中/跟进超时；done+autoDone=自动解决；疑似桶优先
        const isOpen = it.status === 'open'
        const doubtRow = !!(isOpen && it.needConfirm)
        const stLabel = doubtRow
          ? '疑似'
          : isOpen
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
                className={`gip-cell-st gip-st ${isOpen && it.followUp ? 'is-follow' : `is-${it.status}`}${
                  doubtRow ? ' is-doubt' : ''
                }`}
              >
                {stLabel}
              </span>
              <span className="gip-cell-main">
                <span className="gip-title-line">
                  <i className={`gip-type t-${it.type}`}>{it.type}</i>
                  {it.severity && it.severity !== '一般' && (
                    <em className={`gip-sev is-${it.severity === '紧急' ? 'urgent' : 'high'}`}>
                      {it.severity}
                    </em>
                  )}
                  {(it.reopenCount ?? 0) > 0 && (
                    <em className="gip-sev is-reopen">复发×{it.reopenCount}</em>
                  )}
                  {/* 默认跟进人：已指派显示人名；未指派但有人回复过 → 一键指派给回复人 */}
                  {it.assignee ? (
                    <em className="gip-owner-tag" title={`跟进人：${nameOf(it.assignee)}`}>
                      {nameOf(it.assignee)}
                    </em>
                  ) : it.lastReplyBy ? (
                    <button
                      type="button"
                      className="gip-owner-sug"
                      title={`${nameOf(it.lastReplyBy)} 回复过这条问题：点击指派为跟进人`}
                      onClick={(e) => {
                        e.stopPropagation()
                        void assignIssue(it.id, it.lastReplyBy ?? null)
                      }}
                    >
                      + 指派给{nameOf(it.lastReplyBy)}
                    </button>
                  ) : (
                    <em className="gip-owner-none">未指派</em>
                  )}
                  <b>{it.title}</b>
                </span>
                <span className="gip-sub-line">
                  首现 {fmtTime(it.occurAt)} · 证据 {it.msgCount} 条
                  {it.method === 'llm' ? ' · AI 提炼' : ' · 规则'}
                  {it.assignee ? ` · 跟进 ${nameOf(it.assignee)}` : ''}
                </span>
              </span>
              <span className="gip-cell-x gip-caret">{expanded ? '▾' : '▸'}</span>
            </div>
            {expanded && (
              <div className="gip-detail-wrap">
                {detailLoading && !detail ? (
                  <div className="gip-empty-box">加载证据中…</div>
                ) : (
                  <IssueTimeline
                    detail={detail}
                    issue={it}
                    onLocate={locate}
                    members={members}
                    nameOf={nameOf}
                    wxid={wxid ?? ''}
                    teamUsernames={teamUsernames}
                    onMarkTeam={() => setTeamReloadKey((k) => k + 1)}
                  />
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
          <button
            type="button"
            className="gip-btn danger"
            disabled={analyzing || issues.length === 0}
            onClick={onClearAll}
            title="删除本群全部问题记录(含历史/证据)并立即重新提取,不可恢复"
          >
            清空重析
          </button>
        </div>
      </div>

      {/* 统计 */}
      <div className="gip-stats">
        {groups.doubt.length > 0 && (
          <span className="gip-stat is-doubt">疑似 {groups.doubt.length}</span>
        )}
        <span className="gip-stat is-open">
          待处理 {issues.filter((i) => i.status === 'open' && !i.followUp && !i.needConfirm).length}
        </span>
        <span className="gip-stat is-follow">
          跟进中 {issues.filter((i) => i.status === 'open' && i.followUp && !i.needConfirm).length}
        </span>
        <span className="gip-stat is-done">
          已解决 {issues.filter((i) => i.status === 'done').length}
        </span>
        {groups.history.some((i) => i.status === 'stalled') && (
          <span className="gip-stat is-stalled">
            已搁置 {groups.history.filter((i) => i.status === 'stalled').length}
          </span>
        )}
        {(analyzedAt || methodHint || coverage) && (
          <span
            className="gip-meta"
            title={
              coverage?.truncated
                ? `本群消息超过单次扫描上限，本次只分析了最新的 ${coverage.msgs} 条：窗口内更早的消息未覆盖，可用「重新分析」缩小窗口或分批处理`
                : '本次分析实际读取并参与提取的消息条数'
            }
          >
            {analyzedAt ? `${fmtTime(analyzedAt)} · ` : ''}
            {methodHint}
            {coverage ? ` · 覆盖 ${coverage.msgs} 条` : ''}
            {coverage?.truncated ? ' · 条数超限未覆盖全窗口' : ''}
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

      {/* 疑似待确认（规则弱命中，核实后计入待办） */}
      {groups.doubt.length > 0 && (
        <div className="gip-doubt-head">
          疑似待确认 {groups.doubt.length} 条 · 规则弱命中，展开核实为真问题或归档
        </div>
      )}
      {groups.doubt.length > 0 && renderList(groups.doubt, '状态')}

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
            <span>已处理（{groups.history.length}）</span>
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
