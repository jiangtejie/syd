import { useEffect, useMemo, useRef, useState } from 'react'
import { useWorkbenchStore } from '../../stores/workbench'
import SuggestionPanel from './SuggestionPanel'
import GroupIssuesPanel from './GroupIssuesPanel'

/**
 * 右栏双视图容器（宽栏）。
 * - 群会话：「群问题 / 回复建议」两个视图可切换（默认「群问题」）；
 * - 私聊/公众号等非群会话：仅「回复建议」（原智能建议功能）。
 */

type SideView = 'issues' | 'suggest'

type SessionKind = 'none' | 'chat' | 'group'

function SidePanel(): React.JSX.Element {
  const activeSessionId = useWorkbenchStore((s) => s.activeSessionId)
  const sessions = useWorkbenchStore((s) => s.sessions)
  const issues = useWorkbenchStore((s) => s.groupIssues)
  const openCount = useMemo(
    () => issues.reduce((n, i) => (i.status === 'open' ? n + 1 : n), 0),
    [issues]
  )
  const [view, setView] = useState<SideView>('suggest')
  const lastKind = useRef<SessionKind>('none')

  const session = sessions.find((s) => s.username === activeSessionId)
  const isGroup = !!activeSessionId && !!session?.isGroup

  // 会话类型切换时复位视图：进入群默认「群问题」，进入私聊回到「回复建议」；群 ↔ 群保持用户选择
  useEffect(() => {
    const kind: SessionKind = !activeSessionId ? 'none' : isGroup ? 'group' : 'chat'
    if (kind !== lastKind.current) {
      lastKind.current = kind
      setView(kind === 'group' ? 'issues' : 'suggest')
    }
  }, [activeSessionId, isGroup])

  return (
    <div className="wb-pane">
      {isGroup && (
        <div className="wb-pane-tabs" role="tablist" aria-label="右侧栏视图">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'issues'}
            className={`wb-pane-tab${view === 'issues' ? ' is-active' : ''}`}
            onClick={() => setView('issues')}
          >
            群问题
            {openCount > 0 && (
              <em className="wb-pane-badge">{openCount > 99 ? '99+' : openCount}</em>
            )}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'suggest'}
            className={`wb-pane-tab${view === 'suggest' ? ' is-active' : ''}`}
            onClick={() => setView('suggest')}
          >
            回复建议
          </button>
        </div>
      )}
      <div className="wb-pane-content">
        {view === 'issues' && isGroup ? <GroupIssuesPanel /> : <SuggestionPanel />}
      </div>
    </div>
  )
}

export default SidePanel
