import { IssueActions } from './IssueBits'
import { TeamMarkButton } from '../TeamMarkButton'
import { statusChip } from '../../lib/monitorChips'
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
}): React.JSX.Element | null {
  if (!active) return null
  return (
    <div className="mon-card mon-drawer">
      <div className="mon-drawer-head">
        <span className={`mon-st ${statusChip(active).cls}`}>{statusChip(active).label}</span>
        <span className="mon-row-type">{active.type}</span>
        <button
          type="button"
          className="mon-x"
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
        {active.groupName || active.groupUsername} · 首现 {fmtTimeShort(active.occurAt)}
        {active.status === 'open' && <> · 已积压 {ageText(active.occurAt)}</>}
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
          {active.severity && active.severity !== '一般' && (
            <em className={`mon-sev is-${active.severity === '紧急' ? 'urgent' : 'high'}`}>
              {active.severity}优先级
            </em>
          )}
          {(active.reopenCount ?? 0) > 0 && (
            <em className="mon-reopen">
              本议题第 {(active.reopenCount ?? 0) + 1} 次出现（含此前 {active.reopenCount ?? 0}{' '}
              次已闭环记录）
            </em>
          )}
        </div>
      ) : null}

      <div className="mon-drawer-owner">
        <span className="mon-drawer-owner-label">跟进人</span>
        <select
          className="mon-select mon-owner-select-wide"
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
            className="mon-btn ghost"
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
          <div className="mon-drawer-empty">加载证据中…</div>
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
                    <time>{fmtTimeShort(m.time)}</time>
                    {i === 0 && <em className="mon-tl-mark">首现</em>}
                    {i === detail.related.length - 1 && detail.related.length > 1 && (
                      <em className="mon-tl-mark">最新</em>
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
            className="mon-btn primary"
            onClick={() => void onConfirmDoubt(active.id)}
            title="核实为真实问题，移出疑似桶并计入待办"
          >
            ✓ 核实为真问题
          </button>
        )}
        <IssueActions issue={detail ?? active} onSet={(s) => void onSetStatus(active.id, s)} />
        <button
          type="button"
          className="mon-btn ghost"
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
