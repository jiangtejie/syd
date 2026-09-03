import { useEffect, useMemo, useState } from 'react'
import { useWorkbenchStore } from '../stores/workbench'
import { avatarColor, formatSessionTime } from '../lib/ui'
import { useSessionAvatar } from '../lib/sessionAvatar'
import { deriveCustomers, secondaryLabel, TAG_ORDER, type CustomerProfile } from '../lib/customers'
import './customers.css'

/**
 * 客户页：私域客户列表（状态标签筛选）+ 画像抽屉。
 * 列表与标签全部来自微信真实会话数据（未读/最后消息时间/会话类型/置顶），无示例算法。
 */

/** 每页条数选项 */
const PAGE_SIZES = [10, 20, 50, 100]

/** 真实头像：会话自带 URL 优先，失败/缺失时经 IPC 取本地 head_image，最后回退首字块 */
function CustomerAvatar({
  profile,
  size
}: {
  profile: CustomerProfile
  size?: 'lg'
}): React.JSX.Element {
  const { avatarUrl, markUrlFailed } = useSessionAvatar(profile.session)
  // 仅屏蔽当前 URL 的加载失败；头像源变更（如本地兜底）后可自动重试
  const [broken, setBroken] = useState<string | null>(null)
  const cls = size === 'lg' ? 'cu-avatar lg' : 'cu-avatar'
  if (avatarUrl && /^(https?:|data:image)/.test(avatarUrl) && broken !== avatarUrl) {
    return (
      <img
        className={`${cls} cu-avatar-img`}
        src={avatarUrl}
        alt={profile.name.slice(0, 1)}
        referrerPolicy="no-referrer"
        onError={() => {
          setBroken(avatarUrl ?? null)
          markUrlFailed()
        }}
      />
    )
  }
  return (
    <div className={cls} style={{ background: avatarColor(profile.name) }}>
      {profile.name.slice(0, 1)}
    </div>
  )
}

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
          <CustomerAvatar profile={customer} size="lg" />
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
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [jumpValue, setJumpValue] = useState('')
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
  // 已选标签若已从可选集合消失（时间窗口/会话更新导致），按未筛选处理，避免残留空筛选
  const effectiveTag = tagFilter !== null && tagOptions.includes(tagFilter) ? tagFilter : null
  const hasFilters = keyword.trim() !== '' || effectiveTag !== null

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return customers.filter((c) => {
      if (effectiveTag && !c.statusTags.includes(effectiveTag)) return false
      if (!kw) return true
      return (
        c.name.toLowerCase().includes(kw) ||
        c.remark.toLowerCase().includes(kw) ||
        c.nickname.toLowerCase().includes(kw) ||
        c.wxid.toLowerCase().includes(kw) ||
        c.statusTags.some((t) => t.includes(kw))
      )
    })
  }, [customers, effectiveTag, keyword])

  // 筛选/搜索/每页条数变化时回到第 1 页；数据增减导致当前页超界时自动收敛到最后一页
  useEffect(() => {
    setPage(1)
    setJumpValue('')
  }, [effectiveTag, keyword, pageSize])

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const curPage = Math.min(page, totalPages)
  const pageItems = useMemo(
    () => filtered.slice((curPage - 1) * pageSize, curPage * pageSize),
    [filtered, curPage, pageSize]
  )
  const goPage = (p: number): void => setPage(Math.min(Math.max(p, 1), totalPages))
  const applyJump = (): void => {
    const n = Number.parseInt(jumpValue, 10)
    if (!Number.isNaN(n) && n >= 1) goPage(n)
    setJumpValue('')
  }

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
            className={`cu-filter${effectiveTag === null ? ' is-active' : ''}`}
            onClick={() => setTagFilter(null)}
          >
            全部
          </button>
          {tagOptions.map((t) => (
            <button
              key={t}
              type="button"
              className={`cu-filter${effectiveTag === t ? ' is-active' : ''}`}
              onClick={() => setTagFilter(effectiveTag === t ? null : t)}
            >
              {t} {tagCounts.get(t)}
            </button>
          ))}
          {hasFilters && (
            <button
              type="button"
              className="cu-filter cu-filter-clear"
              onClick={() => {
                setKeyword('')
                setTagFilter(null)
              }}
            >
              ✕ 清空条件
            </button>
          )}
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
        {pageItems.map((c) => (
          <div key={c.wxid} className="cu-row" onClick={() => setSelected(c)}>
            <span className="cu-cell-name">
              <CustomerAvatar profile={c} />
              <span className="cu-name-stack">
                <span className="cu-name-text">{c.name}</span>
                {secondaryLabel(c) && <span className="cu-name-sub">{secondaryLabel(c)}</span>}
              </span>
            </span>
            <span className={`cu-muted cu-cell-kind${c.isGroup ? ' is-group' : ''}`}>
              {c.isGroup ? '群聊' : '个人'}
            </span>
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
            {hasFilters
              ? `没有符合条件${
                  effectiveTag ? `（标签：${effectiveTag}）` : ''
                }的客户，可点击「清空条件」重新筛选`
              : '暂无客户数据，请先连接微信'}
          </div>
        )}
        {totalPages > 1 && (
          <div className="cu-pager">
            <span className="cu-pager-info">共 {filtered.length} 条</span>
            <div className="cu-pager-ctrl">
              <select
                className="cu-pager-select"
                value={pageSize}
                onChange={(e) => setPageSize(Number(e.target.value))}
                aria-label="每页条数"
              >
                {PAGE_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n} 条/页
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="cu-pager-btn"
                disabled={curPage <= 1}
                onClick={() => goPage(curPage - 1)}
              >
                ‹ 上一页
              </button>
              <span className="cu-pager-now">
                第 {curPage} / {totalPages} 页
              </span>
              <button
                type="button"
                className="cu-pager-btn"
                disabled={curPage >= totalPages}
                onClick={() => goPage(curPage + 1)}
              >
                下一页 ›
              </button>
              <div className="cu-pager-jump">
                <input
                  className="cu-pager-jump-input"
                  placeholder={`跳至 ${curPage}`}
                  value={jumpValue}
                  inputMode="numeric"
                  onChange={(e) => setJumpValue(e.target.value.replace(/\D/g, ''))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') applyJump()
                  }}
                />
                <button
                  type="button"
                  className="cu-pager-btn"
                  disabled={jumpValue === ''}
                  onClick={applyJump}
                >
                  跳转
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {selected && <ProfileDrawer customer={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}

export default CustomersPage
