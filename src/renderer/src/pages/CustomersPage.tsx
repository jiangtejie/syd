import { useEffect, useMemo, useState } from 'react'
import { useWorkbenchStore } from '../stores/workbench'
import { avatarColor, formatSessionTime } from '../lib/ui'
import { deriveCustomers, type CustomerProfile } from '../lib/customers'
import './customers.css'

/**
 * 客户页：私域客户列表（分层/标签/活跃度）+ 画像抽屉。
 * 档案数据当前由会话派生（示例算法），客户库接入后替换。
 */

type TierFilter = 'all' | 'vip' | 'normal'

function ProfileDrawer({
  customer,
  onClose
}: {
  customer: CustomerProfile
  onClose: () => void
}): React.JSX.Element {
  const gotoSession = useWorkbenchStore((s) => s.gotoSession)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="cu-drawer-mask" onClick={onClose}>
      <div className="cu-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="cu-drawer-head">
          <div className="cu-avatar lg" style={{ background: avatarColor(customer.name) }}>
            {customer.name.slice(0, 1)}
          </div>
          <div className="cu-drawer-title">
            <div className="cu-name-row">
              <span className="cu-name">{customer.name}</span>
              {customer.tier === 'vip' && <span className="cu-tier">VIP</span>}
              {customer.isGroup && <span className="cu-tag-chip">群聊</span>}
            </div>
            <div className="cu-wxid">{customer.wxid}</div>
          </div>
          <button type="button" className="cu-drawer-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="cu-section">
          <div className="cu-section-title">标签</div>
          <div className="cu-tags">
            {customer.tags.length > 0 ? (
              customer.tags.map((t) => (
                <span key={t} className="cu-tag-chip">
                  {t}
                </span>
              ))
            ) : (
              <span className="cu-muted">暂无标签</span>
            )}
          </div>
        </div>

        <div className="cu-section">
          <div className="cu-section-title">活跃情况</div>
          <div className="cu-kv">
            <span>最近活跃</span>
            <span>{formatSessionTime(customer.lastActive)}</span>
          </div>
          <div className="cu-kv">
            <span>活跃度评分</span>
            <span>{customer.activeScore}</span>
          </div>
          <div className="cu-kv">
            <span>未读消息</span>
            <span>{customer.unreadCount}</span>
          </div>
          <div className="cu-kv">
            <span>最近消息</span>
            <span className="cu-summary-cell">{customer.summary || '—'}</span>
          </div>
        </div>

        <button
          type="button"
          className="cu-goto"
          onClick={() => {
            onClose()
            gotoSession(customer.wxid)
          }}
        >
          进入会话
        </button>
        <div className="cu-drawer-hint">客户画像为示例算法生成，客户库接入后展示真实档案</div>
      </div>
    </div>
  )
}

function CustomersPage(): React.JSX.Element {
  const sessions = useWorkbenchStore((s) => s.sessions)
  const [tierFilter, setTierFilter] = useState<TierFilter>('all')
  const [keyword, setKeyword] = useState('')
  const [selected, setSelected] = useState<CustomerProfile | null>(null)

  const customers = useMemo(() => deriveCustomers(sessions), [sessions])
  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return customers.filter((c) => {
      if (tierFilter !== 'all' && c.tier !== tierFilter) return false
      if (!kw) return true
      return (
        c.name.toLowerCase().includes(kw) ||
        c.wxid.toLowerCase().includes(kw) ||
        c.tags.some((t) => t.includes(kw))
      )
    })
  }, [customers, tierFilter, keyword])

  const vipCount = customers.filter((c) => c.tier === 'vip').length

  return (
    <div className="page-scroll">
      <h2 className="page-title">客户</h2>
      <div className="page-subtitle">
        共 {customers.length} 位客户 · VIP {vipCount} 位
      </div>

      <div className="cu-toolbar">
        <input
          className="cu-search"
          placeholder="搜索客户名 / 标签 / wxid"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <div className="cu-filters">
          {(['all', 'vip', 'normal'] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={`cu-filter${tierFilter === t ? ' is-active' : ''}`}
              onClick={() => setTierFilter(t)}
            >
              {t === 'all' ? '全部' : t === 'vip' ? 'VIP' : '普通'}
            </button>
          ))}
        </div>
      </div>

      <div className="cu-list page-card">
        <div className="cu-row cu-row-head">
          <span>客户</span>
          <span>分层</span>
          <span>标签</span>
          <span>活跃度</span>
          <span>最近活跃</span>
          <span>未读</span>
        </div>
        {filtered.map((c) => (
          <div key={c.wxid} className="cu-row" onClick={() => setSelected(c)}>
            <span className="cu-cell-name">
              <span className="cu-avatar" style={{ background: avatarColor(c.name) }}>
                {c.name.slice(0, 1)}
              </span>
              <span className="cu-name-text">{c.name}</span>
            </span>
            <span>{c.tier === 'vip' ? <span className="cu-tier">VIP</span> : <span className="cu-muted">普通</span>}</span>
            <span className="cu-cell-tags">
              {c.tags.slice(0, 2).map((t) => (
                <span key={t} className="cu-tag-chip">
                  {t}
                </span>
              ))}
              {c.tags.length > 2 && <span className="cu-muted">+{c.tags.length - 2}</span>}
            </span>
            <span>
              <span className="cu-score-bar">
                <span className="cu-score-fill" style={{ width: `${c.activeScore}%` }} />
              </span>
              <span className="cu-score-num">{c.activeScore}</span>
            </span>
            <span className="cu-muted">{formatSessionTime(c.lastActive)}</span>
            <span>
              {c.unreadCount > 0 ? <span className="cu-unread">{c.unreadCount}</span> : <span className="cu-muted">—</span>}
            </span>
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="cu-empty">{keyword || tierFilter !== 'all' ? '没有匹配的客户' : '暂无客户数据，请先连接微信'}</div>
        )}
      </div>

      {selected && <ProfileDrawer customer={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}

export default CustomersPage
