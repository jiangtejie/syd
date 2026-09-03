import { useEffect, useRef } from 'react'
import { useWorkbenchStore } from '../stores/workbench'
import SessionList from '../components/workbench/SessionList'
import MessagePanel from '../components/workbench/MessagePanel'
import SidePanel from '../components/workbench/SidePanel'
import './workbench.css'

/**
 * 客服工作台（T6）。
 * 布局：左栏会话列表 | 中栏消息区 | 右栏（群问题 / 回复建议 双视图）
 */
function Workbench(): React.JSX.Element {
  const wxid = useWorkbenchStore((s) => s.wxid)
  const fallbackReason = useWorkbenchStore((s) => s.fallbackReason)
  const init = useWorkbenchStore((s) => s.init)

  useEffect(() => {
    void init(wxid || 'wxid_demo')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 群消息变化 → 90s 静默后自动增量分析当前打开的群（水位与 2 分钟防抖在主进程兜底，
  // 无新消息时零 LLM 成本；用户离开该会话则放弃）
  const debounceRef = useRef<number | null>(null)
  useEffect(() => {
    const unsub = window.api?.cs?.wx?.onDbChanged?.(() => {
      const st = useWorkbenchStore.getState()
      const cur = st.sessions.find((s) => s.username === st.activeSessionId)
      if (!cur?.isGroup) return
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current)
      debounceRef.current = window.setTimeout(() => {
        debounceRef.current = null
        const now = useWorkbenchStore.getState()
        if (now.activeSessionId === cur.username) void now.loadGroupIssues(cur.username)
      }, 90_000)
    })
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current)
      unsub?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="workbench">
      <aside className="wb-sessions">
        <SessionList />
      </aside>
      <main className="wb-chat">
        <MessagePanel />
      </main>
      <aside className="wb-suggest">
        <SidePanel />
      </aside>
      {fallbackReason && (
        <div className="wb-banner">
          <span className="wb-banner-dot" />
          {fallbackReason}
        </div>
      )}
    </div>
  )
}

export default Workbench
