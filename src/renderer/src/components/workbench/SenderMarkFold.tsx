import { useEffect, useMemo, useState } from 'react'
import { useWorkbenchStore } from '../../stores/workbench'

/** 已发起过加载的「群:问题条数」键：放模块级，避免在 effect 里同步 setState 触发二次渲染 */
const requestedKeys = new Set<string>()

/**
 * 「同事标记」折叠面板：一次把本群发过言的同事标完。
 *
 * 为什么需要：跟进判定靠 team_member 名单区分「客户」与「我方同事」。名单缺人时，
 * 同事的回复会被当成客户发言，议题永远停在「待处理」—— 单条证据时间线上的
 * 「标记同事」要一条条点，群里同事一多就没人愿意点。这里按发言人聚合一次标完。
 * 数据源：issue_feedback_msg 里该群的非我方发言人（按证据条数排序）。
 */
export function SenderMarkFold({
  teamUsernames
}: {
  teamUsernames: string[]
}): React.JSX.Element | null {
  const wxid = useWorkbenchStore((s) => s.wxid)
  const activeSessionId = useWorkbenchStore((s) => s.activeSessionId)
  const senders = useWorkbenchStore((s) => s.groupSenders)
  const loading = useWorkbenchStore((s) => s.groupSendersLoading)
  const load = useWorkbenchStore((s) => s.loadGroupSenders)
  const mark = useWorkbenchStore((s) => s.markSendersTeam)
  const issueCount = useWorkbenchStore((s) => s.groupIssues.length)
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [pickedFor, setPickedFor] = useState<string | null>(null)
  const loadKey = `${activeSessionId ?? ''}:${issueCount}`

  // 换群时复位勾选（避免把上一个群的人标到当前群）；渲染期比对，不在 effect 里同步 setState
  if (pickedFor !== activeSessionId) {
    setPickedFor(activeSessionId)
    setPicked([])
  }

  // 展开时懒加载发言人列表（键=群+问题条数：新分析产出后允许再取一次，避免候选过期）
  useEffect(() => {
    if (!open || !activeSessionId) return
    if (requestedKeys.has(loadKey)) return
    requestedKeys.add(loadKey)
    void load()
  }, [open, loadKey, activeSessionId, load])

  // 已在名单里的同事不再作为候选（历史行的 is_team 可能是旧值）
  const candidates = useMemo(
    () => senders.filter((s) => !teamUsernames.includes(s.username)),
    [senders, teamUsernames]
  )

  if (!wxid || !activeSessionId) return null
  const marking = picked.length > 0

  const toggleOne = (u: string): void =>
    setPicked((p) => (p.includes(u) ? p.filter((x) => x !== u) : [...p, u]))

  return (
    <div className="gip-senders">
      <button
        type="button"
        className="gip-fold-btn"
        onClick={() => setOpen((o) => !o)}
        title="本群里发过言的同事如果没标记，TA 的回复会被当成客户发言，议题会一直停在「待处理」"
      >
        <span>
          同事标记{open && candidates.length > 0 ? `（${candidates.length} 位未标识）` : ''}
        </span>
        <span className="gip-caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="gip-senders-body">
          {loading && candidates.length === 0 ? (
            <div className="gip-empty">读取本群发言人…</div>
          ) : candidates.length === 0 ? (
            <div className="gip-empty">
              本群没有待标识的发言人 ✓（同事都在名单里，或本群还没有问题证据）
            </div>
          ) : (
            <>
              <div className="gip-senders-hint">
                勾选后点「标记为同事」：TA 的发言会被算作我方回复，相关议题进入「跟进中」
              </div>
              <div className="gip-senders-list">
                {candidates.map((s) => (
                  <label key={s.username} className="gip-sender-row">
                    <input
                      type="checkbox"
                      checked={picked.includes(s.username)}
                      onChange={() => toggleOne(s.username)}
                    />
                    <span className="gip-sender-name">{s.name}</span>
                    <span className="gip-sender-count">{s.count} 条</span>
                  </label>
                ))}
              </div>
              <div className="gip-senders-ops">
                <button
                  type="button"
                  className="gip-btn"
                  onClick={() =>
                    setPicked(
                      picked.length === candidates.length ? [] : candidates.map((s) => s.username)
                    )
                  }
                >
                  {picked.length === candidates.length ? '取消全选' : '全选'}
                </button>
                <button
                  type="button"
                  className="gip-btn primary"
                  disabled={!marking}
                  onClick={() => {
                    const users = [...picked]
                    setPicked([])
                    void mark(users)
                  }}
                >
                  标记为同事{marking ? `（${picked.length}）` : ''}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
