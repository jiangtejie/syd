import { useWorkbenchStore } from '../stores/workbench'
import { APP_NAME } from '../../../shared/appInfo'

/**
 * 自定义标题栏（36px）。
 * 配合主进程 titleBarStyle:'hidden' + titleBarOverlay（原生窗控按钮在右上）。
 * 整栏为拖拽区（-webkit-app-region: drag），双击切换最大化。
 */

const PAGE_NAMES: Record<string, string> = {
  workbench: 'AI',
  monitor: '监控',
  chat: '对话',
  customers: '客户',
  duty: '值班',
  // 「运营看板」已并入「监控」页签（见 pages/MonitorShell.tsx），不再有独立页面键
  export: '数据',
  settings: '设置'
}

function TitleBar(): React.JSX.Element {
  const page = useWorkbenchStore((s) => s.page)
  const sessions = useWorkbenchStore((s) => s.sessions)
  const unread = sessions.reduce((n, s) => n + s.unreadCount, 0)

  return (
    <div className="app-titlebar">
      {/* 品牌标记：一小颗霓虹菱形，替代原来纯文字的重心 */}
      <span className="app-titlebar-mark" aria-hidden="true" />
      <span className="app-titlebar-name">{APP_NAME}</span>
      <span className="app-titlebar-page">{PAGE_NAMES[page] ?? ''}</span>
      {unread > 0 && <span className="app-titlebar-badge">{unread > 99 ? '99+' : unread}</span>}
    </div>
  )
}

export default TitleBar
