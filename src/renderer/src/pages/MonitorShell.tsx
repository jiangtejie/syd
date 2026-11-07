import './monitor-shell.css'
import { Suspense, lazy } from 'react'
import { useWorkbenchStore, type MonitorTab } from '../stores/workbench'

/**
 * 「监控」页外壳：把原来的两个导航项（问题监控 / 运营看板）收成一个入口 + 两个页签。
 *
 * 为什么这么合（长期维护角度）：
 * - 两页是同一件事的上下游：看板发现"待回复/超时未回"，下一步就是去监控处置；合并后同屏一次点击；
 * - 导航从 8 项减到 7 项，且「监控」「运营看板」两个名字本来就分不清哪个是"看数据的"；
 * - **只挂载当前页签**：两个面板都会订阅账号/数据变更做全量刷新，同时挂载会双份刷新；
 * - 两个面板文件互不依赖、各自独立演进（第三个页签将来直接往 TABS 里加一行）。
 *
 * 页签选择记在 store 的 monitorTab（localStorage 记忆）；历史页面键 'dashboard' 在 App 的 onNavigate
 * 里被收敛到「监控 + 运营看板」，所以外部跳转不用改。
 */

const MonitorPage = lazy(() => import('./MonitorPage'))
const DashboardPage = lazy(() => import('./DashboardPage'))

const TABS: Array<{ key: MonitorTab; label: string; desc: string }> = [
  {
    key: 'issues',
    label: '问题监控',
    desc: '客诉闭环：KPI 口径(待处理/跟进超时/疑似) · 追踪列表与处置指派 · 趋势图表 · 飞书表格同步'
  },
  {
    key: 'ops',
    label: '运营看板',
    // 口径写死在壳上：连接微信数据前该页只有空态，所以这里不能像原来那样断言「来自真实微信库」
    desc: '会话与消息指标(连接微信数据后展示) · 待回复队列 · 发送统计与质量(真实审计 send_log)'
  }
]

export default function MonitorShell(): React.JSX.Element {
  const tab = useWorkbenchStore((s) => s.monitorTab)
  const setTab = useWorkbenchStore((s) => s.setMonitorTab)
  const meta = TABS.find((t) => t.key === tab) ?? TABS[0]

  return (
    <div className="page-scroll mon-page">
      <div className="mon-head">
        <h2 className="page-title">监控</h2>
        <div className="mon-tabs" role="tablist" aria-label="监控板块">
          {TABS.map((t, i) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={`ui-tab mon-tab${tab === t.key ? ' is-active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              <span className="mon-tab-no ui-num">{String(i + 1).padStart(2, '0')}</span>
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="page-subtitle mon-subtitle">{meta.desc}</div>
      <Suspense
        fallback={
          <div className="mon-loading">
            <span className="ui-spin" aria-hidden="true" />
            加载中…
          </div>
        }
      >
        {tab === 'ops' ? <DashboardPage /> : <MonitorPage />}
      </Suspense>
    </div>
  )
}
