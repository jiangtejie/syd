import { useEffect } from 'react'
import { useWorkbenchStore } from '../stores/workbench'
import SessionList from '../components/workbench/SessionList'
import MessagePanel from '../components/workbench/MessagePanel'
import SuggestionPanel from '../components/workbench/SuggestionPanel'
import './workbench.css'

/**
 * 客服工作台（T6）。
 * 布局：左栏会话列表 | 中栏消息区 | 右栏建议条（T7 填充）
 */
function Workbench(): React.JSX.Element {
  const wxid = useWorkbenchStore((s) => s.wxid)
  const fallbackReason = useWorkbenchStore((s) => s.fallbackReason)
  const init = useWorkbenchStore((s) => s.init)

  useEffect(() => {
    void init(wxid || 'wxid_demo')
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
        <SuggestionPanel />
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
