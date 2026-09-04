import { useEffect, useState } from 'react'
import { useWorkbenchStore, type WorkbenchPage } from './stores/workbench'
import Workbench from './pages/Workbench'
import AiChatPage from './pages/AiChatPage'
import MonitorPage from './pages/MonitorPage'
import CustomersPage from './pages/CustomersPage'
import DashboardPage from './pages/DashboardPage'
import ExportPage from './pages/ExportPage'
import SettingsPage from './pages/SettingsPage'
import TitleBar from './components/TitleBar'
import ToastHost from './components/ToastHost'
import ErrorBoundary from './components/ErrorBoundary'
import './pages/shell.css'

/**
 * 应用外壳：顶部自定义标题栏（拖拽区）+ 左侧导航栏 + 页面区。
 * 对话页（Workbench）始终保持挂载（隐藏不卸载），切页不丢滚动位置与输入状态。
 */

type NavIconName = 'ai' | 'monitor' | 'chat' | 'customers' | 'dashboard' | 'export' | 'settings'

/** 线性描边图标（feather/lucide 风格，跟随 currentColor），替代 Emoji 更贴近桌面工具质感 */
function NavIcon({ name }: { name: NavIconName }): React.JSX.Element {
  const attrs = {
    width: 20,
    height: 20,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const
  }
  switch (name) {
    case 'ai':
      return (
        <svg {...attrs}>
          <path d="M12 2.5 14 9l6.5 2-6.5 2-2 6.5L10 13l-6.5-2L10 9z" />
        </svg>
      )
    case 'monitor':
      return (
        <svg {...attrs}>
          <path d="M2 12h4l3-8 4 16 3-8h6" />
        </svg>
      )
    case 'chat':
      return (
        <svg {...attrs}>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      )
    case 'customers':
      return (
        <svg {...attrs}>
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      )
    case 'dashboard':
      return (
        <svg {...attrs}>
          <rect x="3" y="3" width="7" height="7" rx="1.2" />
          <rect x="14" y="3" width="7" height="7" rx="1.2" />
          <rect x="14" y="14" width="7" height="7" rx="1.2" />
          <rect x="3" y="14" width="7" height="7" rx="1.2" />
        </svg>
      )
    case 'settings':
      return (
        <svg {...attrs}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      )
    case 'export':
      return (
        <svg {...attrs}>
          <path d="M12 3v12" />
          <path d="m7 10 5 5 5-5" />
          <path d="M5 21h14" />
        </svg>
      )
  }
}

const NAV_ITEMS: Array<{ key: WorkbenchPage; icon: NavIconName; label: string }> = [
  { key: 'ai', icon: 'ai', label: 'AI' },
  { key: 'monitor', icon: 'monitor', label: '监控' },
  { key: 'dashboard', icon: 'dashboard', label: '看板' },
  { key: 'chat', icon: 'chat', label: '对话' },
  { key: 'customers', icon: 'customers', label: '客户' },
  { key: 'export', icon: 'export', label: '数据' }
]

const VALID_PAGES = new Set(NAV_ITEMS.map((i) => i.key))

const wxApi = window.api?.cs?.wx

/** 空占位人形图标（未连接 / 无头像时展示） */
function PersonIcon(): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <circle cx="12" cy="8.2" r="3.6" />
      <path d="M4.6 20c1.3-3.4 4.1-5.1 7.4-5.1s6.1 1.7 7.4 5.1" />
    </svg>
  )
}

/**
 * 左侧导航顶部：当前微信账号头像 + 连接状态指示灯。
 * 未连接/无头像时展示人形空占位；指示灯：灰=未连接，黄=已选账号但数据未就绪，绿=已连接。
 */
function NavAccountBadge(): React.JSX.Element {
  const wxid = useWorkbenchStore((s) => s.wxid)
  const source = useWorkbenchStore((s) => s.source)
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  const connected = !!wxid && source === 'wx'
  const dotState = !wxid ? 'off' : connected ? 'on' : 'warn'

  // 切换账号/连接状态后重新取当前账号自己的头像（contact URL → head_image 本地头像）
  useEffect(() => {
    let alive = true
    setAvatarUrl(null)
    setFailed(false)
    if (!wxid) return
    wxApi
      ?.getAvatar?.(wxid, wxid)
      .then((res) => {
        if (alive && res?.ok && res.url) setAvatarUrl(res.url)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [wxid, source])

  // 头像地址变化时重置失败态（换成本地兜底图后可重试）
  useEffect(() => setFailed(false), [avatarUrl])

  const showImg = !!avatarUrl && /^(https?:|data:image)/.test(avatarUrl) && !failed
  const statusText = !wxid
    ? '未连接微信：请到 设置 → 微信数据与密钥 导入密钥并连接'
    : connected
      ? `已连接 · ${wxid}`
      : `数据未就绪 · ${wxid}（连接失败或暂无会话）`

  return (
    <div className={`app-nav-avatar${wxid ? ' is-set' : ''}`} title={statusText}>
      {showImg ? (
        <img
          className="app-nav-avatar-img"
          src={avatarUrl}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="app-nav-avatar-empty">
          <PersonIcon />
        </div>
      )}
      <span className={`app-nav-dot ${dotState}`} />
    </div>
  )
}

function App(): React.JSX.Element {
  const page = useWorkbenchStore((s) => s.page)
  const setPage = useWorkbenchStore((s) => s.setPage)
  const sessions = useWorkbenchStore((s) => s.sessions)
  const unread = sessions.reduce((n, s) => n + s.unreadCount, 0)

  // 任务栏/窗口标题带未读数
  useEffect(() => {
    document.title =
      unread > 0 ? `（${unread > 99 ? '99+' : unread} 条未读）微信私域智能客服` : '微信私域智能客服'
  }, [unread])

  // 菜单导航（Ctrl+, 打开设置等）
  useEffect(() => {
    const unsubscribe = window.api?.cs?.app?.onNavigate?.((target) => {
      if (VALID_PAGES.has(target as WorkbenchPage)) setPage(target as WorkbenchPage)
    })
    return unsubscribe
  }, [setPage])

  return (
    <ErrorBoundary>
      <div className="app-shell">
        <TitleBar />
        <div className="app-body">
          <nav className="app-nav">
            <NavAccountBadge />
            {NAV_ITEMS.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`app-nav-item${page === item.key ? ' is-active' : ''}`}
                onClick={() => setPage(item.key)}
              >
                <span className="app-nav-icon">
                  <NavIcon name={item.icon} />
                </span>
                <span className="app-nav-label">{item.label}</span>
              </button>
            ))}
            {/* 设置固定在导航底部 */}
            <div className="app-nav-bottom">
              <span className="app-nav-sep" />
              <button
                type="button"
                className={`app-nav-item${page === 'settings' ? ' is-active' : ''}`}
                onClick={() => setPage('settings')}
              >
                <span className="app-nav-icon">
                  <NavIcon name="settings" />
                </span>
                <span className="app-nav-label">设置</span>
              </button>
            </div>
          </nav>
          <div className="app-main">
            {/* 对话页常驻，仅隐藏 */}
            <div className={`app-page${page === 'chat' ? '' : ' is-hidden'}`}>
              <Workbench />
            </div>
            {page === 'customers' && (
              <div className="app-page">
                <CustomersPage />
              </div>
            )}
            {page === 'export' && (
              <div className="app-page">
                <ExportPage />
              </div>
            )}
            {page === 'ai' && (
              <div className="app-page">
                <AiChatPage />
              </div>
            )}
            {page === 'monitor' && (
              <div className="app-page">
                <MonitorPage />
              </div>
            )}
            {page === 'dashboard' && (
              <div className="app-page">
                <DashboardPage />
              </div>
            )}
            {page === 'settings' && (
              <div className="app-page">
                <SettingsPage />
              </div>
            )}
          </div>
        </div>
        <ToastHost />
      </div>
    </ErrorBoundary>
  )
}

export default App
