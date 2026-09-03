import { useEffect, useMemo, useState } from 'react'
import { useWorkbenchStore } from '../stores/workbench'
import { avatarColor, formatSessionTime } from '../lib/ui'
import { deriveCustomers, TAG_ORDER, type CustomerProfile } from '../lib/customers'
import './customers.css'

/**
 * 客户页：私域客户列表（状态标签筛选）+ 画像抽屉。
 * 列表与标签全部来自微信真实会话数据（未读/最后消息时间/会话类型/置顶），无示例算法。
 */

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
              <span className={`cu-tag-chip${customer.isGroup ? ' is-group' : ''}`}>
                {customer.isGroup ? '群聊' : '个人'}
              </span>
              {customer.unreadCount > 0 && (
                <span className="cu-unread">{customer.unreadCount}</span>
              )}
            </div>
            <div className="cu-wxid">{customer.wxid}</div>
          </div>
          <button type="button" className="cu-drawer-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="cu-section">
          <div className="cu-section-title">状态标签（微信数据实时判断）</div>
          <div className="cu-tags">
            {customer.statusTags.map((t) => (
              <span key={t} className="cu-tag-chip">
                {t}
              </span>
            ))}
          </div>
        </div>

        <div className="cu-section">
          <div className="cu-section-title">资料</div>
          <div className="cu-kv">
            <span>备注</span>
            <span>{customer.remark || '—'}</span>
          </div>
          <div className="cu-kv">
            <span>微信昵称</span>
            <span>{customer.nickname || '—'}</span>
          </div>
        </div>

        <div className="cu-section">
          <div className="cu-section-title">活跃情况</div>
          <div className="cu-kv">
            <span>最近活跃</span>
            <span>{formatSessionTime(customer.lastActive)}</span>
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
        <div className="cu-drawer-hint">标签基于微信会话数据（未读/时间/类型）实时判断</div>
      </div>
    </div>
  )
}

function CustomersPage(): React.JSX.Element {
  const sessions = useWorkbenchStore((s) => s.sessions)
  const refreshSessions = useWorkbenchStore((s) => s.refreshSessions)
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [keyword, setKeyword] = useState('')
  const [selected, setSelected] = useState<CustomerProfile | null>(null)
  /** 当前时间（mount 后异步测量 + 每分钟校准，避免渲染期取 Date.now） */
  const [nowMs, setNowMs] = useState<number>(0)

  useEffect(() => {
    const tick = window.setTimeout(() => setNowMs(Date.now()), 0)
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000)
    return () => {
      window.clearTimeout(tick)
      window.clearInterval(timer)
    }
  }, [])

  // 会话变化（新消息/已读状态）时刷新会话列表
  useEffect(() => {
    const unsubscribe = window.api?.cs?.wx?.onDbChanged?.((payload) => {
      if (payload.info.sessionChanged) void refreshSessions()
    })
    return unsubscribe
  }, [refreshSessions])

  const customers = useMemo(() => deriveCustomers(sessions, nowMs), [sessions, nowMs])

  const tagCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of customers) {
      for (const t of c.statusTags) m.set(t, (m.get(t) ?? 0) + 1)
    }
    return m
  }, [customers])
  const tagOptions = useMemo(() => TAG_ORDER.filter((t) => tagCounts.has(t)), [tagCounts])

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return customers.filter((c) => {
      if (tagFilter && !c.statusTags.includes(tagFilter)) return false
      if (!kw) return true
      return (
        c.name.toLowerCase().includes(kw) ||
        c.remark.toLowerCase().includes(kw) ||
        c.nickname.toLowerCase().includes(kw) ||
        c.wxid.toLowerCase().includes(kw) ||
        c.statusTags.some((t) => t.includes(kw))
      )
    })
  }, [customers, tagFilter, keyword])

  const replyCount = tagCounts.get('待回复') ?? 0

  return (
    <div className="page-scroll">
      <h2 className="page-title">客户</h2>
      <div className="page-subtitle">
        共 {customers.length} 位客户 · 待回复 {replyCount} 位 · 标签为微信数据实时判断
      </div>

      <div className="cu-toolbar">
        <input
          className="cu-search"
          placeholder="搜索客户名 / 备注 / wxid / 标签"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <div className="cu-filters">
          <button
            type="button"
            className={`cu-filter${tagFilter === null ? ' is-active' : ''}`}
            onClick={() => setTagFilter(null)}
          >
            全部
          </button>
          {tagOptions.map((t) => (
            <button
              key={t}
              type="button"
              className={`cu-filter${tagFilter === t ? ' is-active' : ''}`}
              onClick={() => setTagFilter(tagFilter === t ? null : t)}
            >
              {t} {tagCounts.get(t)}
            </button>
          ))}
        </div>
      </div>

      <div className="cu-list page-card">
        <div className="cu-row cu-row-head">
          <span>客户</span>
          <span>类型</span>
          <span>状态标签</span>
          <span>最近消息</span>
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
            <span className="cu-muted cu-cell-kind">{c.isGroup ? '群聊' : '个人'}</span>
            <span className="cu-cell-tags">
              {c.statusTags.slice(0, 2).map((t) => (
                <span key={t} className="cu-tag-chip">
                  {t}
                </span>
              ))}
              {c.statusTags.length > 2 && (
                <span className="cu-muted">+{c.statusTags.length - 2}</span>
              )}
            </span>
            <span className="cu-cell-sum">{c.summary || '—'}</span>
            <span className="cu-muted">{formatSessionTime(c.lastActive)}</span>
            <span>
              {c.unreadCount > 0 ? (
                <span className="cu-unread">{c.unreadCount}</span>
              ) : (
                <span className="cu-muted">—</span>
              )}
            </span>
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="cu-empty">
            {keyword || tagFilter ? '没有匹配的客户' : '暂无客户数据，请先连接微信'}
          </div>
        )}
      </div>

      {selected && <ProfileDrawer customer={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}

export default CustomersPage
