import { IssueActions, SeverityChip, StatusChip } from './IssueBits'
import { TeamMarkButton } from '../TeamMarkButton'
import { ageText, fmtTimeShort } from '../../../../shared/monitorMetrics'
import type {
  FeedbackIssue,
  FeedbackIssueDetail,
  FeedbackIssueStatus,
  TeamMemberInfo
} from '../../../../shared/types'

/**
 * 追踪抽屉：状态/严重度/复发标记 + 跟进人指派与默认跟进人建议 + 证据时间线 + 处置动作。
 * 从 MonitorPage 拆出（页面只负责取数、筛选与布局）。
 *
 * 视觉：右侧浮层面的语言 —— page-card 底 + 顶部一道品牌色细光 + 深色下略强的落影；
 * 没有选中问题时给一块"待选择"空态，保持左右两栏等高、不塌陷。
 */
export function IssueDrawer({
  active,
  detail,
  detailLoading,
  members,
  ownerName,
  wxid,
  teamUsernames,
  onMarkTeam,
  onClose,
  onAssign,
  onSetStatus,
  onConfirmDoubt,
  onLocate
}: {
  active: FeedbackIssue | null
  detail: FeedbackIssueDetail | null
  detailLoading: boolean
  members: TeamMemberInfo[]
  ownerName: (username?: string) => string
  /** 当前微信账号（标记团队客服要用） */
  wxid: string
  /** 已标记的团队客服 username（用于判断是否还要显示「标记同事」） */
  teamUsernames: string[]
  onMarkTeam?: () => void
  onClose: () => void
  onAssign: (id: number, username: string) => void
  onSetStatus: (id: number, status: FeedbackIssueStatus) => void
  onConfirmDoubt: (id: number) => void
  onLocate: (sessionUsername: string, occurAt: number) => void
}): React.JSX.Element {
  if (!active) {
    return (
      <div className="page-card mon-drawer is-idle">
        <div className="ui-empty mon-drawer-idle">
          <div className="ui-empty-glyph" aria-hidden="true">
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="7.5" />
              <circle cx="12" cy="12" r="2.4" />
              <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" />
            </svg>
          </div>
          <div className="ui-empty-title">选择一条问题</div>
          <div className="ui-empty-desc">
            这里会展示该问题的证据时间线、跟进人指派与处置状态，处理动作在底部。
          </div>
          <div className="ui-empty-hint">也可以先按状态 / 类型 / 严重度筛选，再点左侧列表。</div>
        </div>
      </div>
    )
  }

  return (
    <div className="page-card mon-drawer">
      <div className="mon-drawer-head">
        <StatusChip issue={active} />
        <span className="mon-drawer-type">{active.type}</span>
        <button
          type="button"
          className="ui-btn is-ghost is-sm mon-x"
          onClick={() => {
            onClose()
            onClose()
          }}
        >
          ✕
        </button>
      </div>
      <div className="mon-drawer-title">{active.title}</div>
      <div className="mon-drawer-meta">
        {active.groupName || active.groupUsername} · 首现{' '}
        <span className="ui-num">{fmtTimeShort(active.occurAt)}</span>
        {active.status === 'open' && (
          <>
            {' '}
            · 已积压 <span className="ui-num">{ageText(active.occurAt)}</span>
          </>
        )}
      </div>
      {active.summary && <div className="mon-drawer-summary">{active.summary}</div>}
      {/* 处理备注：同事在飞书多维表格里填的结论（回写进本地，只读展示） */}
      {active.note && (
        <div className="mon-drawer-note">
          <b>处理备注</b>
          <span>{active.note}</span>
        </div>
      )}

      {(active.severity && active.severity !== '一般') || (active.reopenCount ?? 0) > 0 ? (
        <div className="mon-drawer-flags">
          <SeverityChip severity={active.severity} />
          {(active.reopenCount ?? 0) > 0 && (
            <em className="ui-chip is-sm mon-reopen-chip">
              本议题第 {(active.reopenCount ?? 0) + 1} 次出现
              <span className="mon-reopen-sub">（含此前 {active.reopenCount ?? 0} 次已闭环）</span>
            </em>
          )}
        </div>
      ) : null}

      <div className="mon-drawer-owner">
        <span className="mon-drawer-owner-label">跟进人</span>
        <select
          className="ui-select mon-select mon-owner-select-wide"
          value={active.assignee ?? ''}
          onChange={(e) => void onAssign(active.id, e.target.value)}
          title="指派/更换跟进人（团队成员，空 = 取消指派）"
        >
          <option value="">未指派</option>
          {members.map((m) => (
            <option key={m.username} value={m.username}>
              {ownerName(m.username)}
            </option>
          ))}
        </select>
        {active.assignee ? (
          <span className="mon-drawer-owner-state">
            由 <b>{ownerName(active.assignee)}</b> 跟进
          </span>
        ) : active.lastReplyBy ? (
          <button
            type="button"
            className="ui-btn is-ghost is-sm"
            title={`${ownerName(active.lastReplyBy)} 回复过这条问题：点击指派为跟进人`}
            onClick={() => void onAssign(active.id, active.lastReplyBy ?? '')}
          >
            指派给 {ownerName(active.lastReplyBy)}
          </button>
        ) : members.length === 0 ? (
          <span className="mon-drawer-owner-hint">
            暂无团队成员：对话页右键消息「标记为团队客服」后即可指派
          </span>
        ) : (
          <span className="mon-drawer-owner-hint">指派后列表可按人筛选跟进</span>
        )}
      </div>

      <div className="mon-drawer-scroll">
        {detailLoading ? (
          <div className="mon-drawer-empty">
            <span className="ui-spin" aria-hidden="true" />
            加载证据中…
          </div>
        ) : !detail ? (
          <div className="mon-drawer-empty">无证据详情</div>
        ) : (
          <div className="mon-drawer-tl">
            {detail.related.map((m, i) => (
              <div key={i} className={`mon-tl-item${m.isSend || m.senderIsTeam ? ' is-my' : ''}`}>
                <span className="mon-tl-dot" />
                <div className="mon-tl-body">
                  <div className="mon-tl-head">
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
                    <time className="ui-num">{fmtTimeShort(m.time)}</time>
                    {i === 0 && <em className="ui-chip is-sm mon-tl-mark">首现</em>}
                    {i === detail.related.length - 1 && detail.related.length > 1 && (
                      <em className="ui-chip is-sm mon-tl-mark">最新</em>
                    )}
                  </div>
                  <div className="mon-tl-text">{m.text || '[非文本消息]'}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mon-drawer-foot">
        {active.needConfirm && active.status === 'open' && (
          <button
            type="button"
            className="ui-btn is-primary is-sm"
            onClick={() => void onConfirmDoubt(active.id)}
            title="核实为真实问题，移出疑似桶并计入待办"
          >
            ✓ 核实为真问题
          </button>
        )}
        <IssueActions issue={detail ?? active} onSet={(s) => void onSetStatus(active.id, s)} />
        <button
          type="button"
          className="ui-btn is-ghost is-sm"
          onClick={() => onLocate(active.groupUsername, active.occurAt)}
          title="跳到该群聊天并滚动到问题首次出现的时间附近"
        >
          ◎ 在聊天中定位
        </button>
      </div>
      {active.autoDone && active.status === 'done' && (
        <div className="mon-drawer-note">系统判定已闭环自动关闭,可重新打开复核</div>
      )}
    </div>
  )
}
