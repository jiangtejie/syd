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
  const msgTimerRef = useRef<number | null>(null)
  useEffect(() => {
    const unsub = window.api?.cs?.wx?.onDbChanged?.(() => {
      const st = useWorkbenchStore.getState()
      const cur = st.sessions.find((s) => s.username === st.activeSessionId)
      // 1) 当前会话消息增量刷新（300ms 防抖）：收到新消息自动出现在聊天窗口
      if (st.activeSessionId) {
        if (msgTimerRef.current !== null) window.clearTimeout(msgTimerRef.current)
        msgTimerRef.current = window.setTimeout(() => {
          msgTimerRef.current = null
          const now = useWorkbenchStore.getState()
          if (now.activeSessionId) void now.refreshCurrentMessages()
        }, 300)
      }
      // 2) 当前打开的群：90s 静默后水位增量分析
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
      if (msgTimerRef.current !== null) window.clearTimeout(msgTimerRef.current)
      unsub?.()
    }
  }, [])

  // 问题数据变化(任意页面处置/分析/后台调度落库):刷新各群徽标;
  // 后台调度新增问题且窗口未聚焦时桌面提醒(30s 节流),点击直达监控中心
  const issueTimerRef = useRef<number | null>(null)
  const issueNotifyAtRef = useRef(0)
  useEffect(() => {
    const unsub = window.api?.cs?.issue?.onChanged?.((p) => {
      if (issueTimerRef.current !== null) window.clearTimeout(issueTimerRef.current)
      issueTimerRef.current = window.setTimeout(() => {
        issueTimerRef.current = null
        const st = useWorkbenchStore.getState()
        if (p?.wxid && st.wxid && st.wxid !== p.wxid) return
        // 当前打开的群直接刷新面板与徽标；其他群只刷徽标
        const cur = st.sessions.find((s) => s.username === st.activeSessionId)
        if (cur?.isGroup) void st.refreshGroupIssues()
        else void st.refreshGroupBadges()
        const added = p && typeof p.added === 'number' ? p.added : 0
        const now = Date.now()
        if (added > 0 && !document.hasFocus() && now - issueNotifyAtRef.current >= 30_000) {
          issueNotifyAtRef.current = now
          if ('Notification' in window && Notification.permission === 'granted') {
            const n = new Notification('群问题监控', {
              body: `后台自动分析发现 ${added} 条新问题，点击查看监控中心`
            })
            n.onclick = (): void => {
              useWorkbenchStore.getState().setPage('monitor')
              window.focus()
            }
          }
        }
      }, 400)
    })
    return () => {
      if (issueTimerRef.current !== null) window.clearTimeout(issueTimerRef.current)
      unsub?.()
    }
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
