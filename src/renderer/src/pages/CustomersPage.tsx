import { useCallback, useEffect, useMemo, useState } from 'react'
import { useWorkbenchStore } from '../stores/workbench'
import { avatarColor, formatSessionTime } from '../lib/ui'
import { useSessionAvatar } from '../lib/sessionAvatar'
import { deriveCustomers, secondaryLabel, TAG_ORDER, type CustomerProfile } from '../lib/customers'
import { toast } from '../stores/toast'
import type { DutyGroupSwitch } from '../../../shared/types'
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

  // ── 数字员工：群级自动回复开关（客户页是批量管理的入口）──
  const wxid = useWorkbenchStore((s) => s.wxid)
  /** 已单独设置过的群（未出现的群继承全局默认） */
  const [switches, setSwitches] = useState<Record<string, DutyGroupSwitch>>({})
  const [defaultOn, setDefaultOn] = useState(true)
  const [defaultMode, setDefaultMode] = useState<'shadow' | 'live'>('shadow')
  /** 多选：群 username */
  const [pickedGroups, setPickedGroups] = useState<string[]>([])
  /** 自动回复筛选：all=全部 / group=仅群聊 / on=已开 / off=已关 */
  const [agentFilter, setAgentFilter] = useState<'all' | 'group' | 'on' | 'off'>('all')
  const [savingScope, setSavingScope] = useState(false)

  const loadSwitches = useCallback(async (): Promise<void> => {
    if (!wxid) return
    const [g, st] = await Promise.all([
      window.api?.cs?.duty?.groups(wxid).catch(() => null),
      window.api?.cs?.duty?.status(wxid).catch(() => null)
    ])
    if (g?.ok && g.switches) setSwitches(g.switches)
    if (st?.ok && st.status) {
      setDefaultOn(st.status.defaultEnabled)
      setDefaultMode(st.status.defaultMode)
    }
  }, [wxid])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 挂载/换账号时拉一次开关（异步，setState 在 await 之后）
    void loadSwitches()
  }, [loadSwitches])

  /** 某群的生效开关（未配置 → 继承全局默认） */
  const groupOn = useCallback(
    (username: string): boolean => switches[username]?.enabled ?? defaultOn,
    [switches, defaultOn]
  )

  /** 写开关：单个或批量（客户端乐观更新 + 失败回滚由重载兜底） */
  const applyScope = useCallback(
    async (
      groups: string[],
      patch: { enabled?: boolean; mode?: 'shadow' | 'live'; reset?: boolean }
    ): Promise<void> => {
      if (!wxid || groups.length === 0) return
      setSavingScope(true)
      const res = await window.api?.cs?.duty?.groupsSet(wxid, groups, patch).catch(() => null)
      setSavingScope(false)
      if (!res?.ok) {
        toast.error(res?.error || '自动回复设置失败')
        return
      }
      if (res.switches) setSwitches(res.switches)
      setPickedGroups([])
      toast.success(
        patch.reset
          ? `已让 ${groups.length} 个群跟随全局默认`
          : `已${patch.enabled ? '开启' : '关闭'} ${groups.length} 个群的自动回复`
      )
    },
    [wxid]
  )

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
      // 自动回复维度只看群（单聊暂不管）；未配置的群按全局默认判定
      if (agentFilter === 'group' && !c.isGroup) return false
      if (agentFilter === 'on' && (!c.isGroup || !groupOn(c.wxid))) return false
      if (agentFilter === 'off' && (!c.isGroup || groupOn(c.wxid))) return false
      if (!kw) return true
      return (
        c.name.toLowerCase().includes(kw) ||
        c.remark.toLowerCase().includes(kw) ||
        c.nickname.toLowerCase().includes(kw) ||
        c.wxid.toLowerCase().includes(kw) ||
        c.statusTags.some((t) => t.includes(kw))
      )
    })
  }, [customers, effectiveTag, keyword, agentFilter, groupOn])

  // 筛选/搜索/每页条数变化时回到第 1 页；数据增减导致当前页超界时自动收敛到最后一页
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 筛选条件变化时回到第 1 页(派生态无法表达)
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
  /** 当前页可选中的群（批量操作的候选） */
  const groupItems = useMemo(() => pageItems.filter((c) => c.isGroup), [pageItems])
  const pickedOnPage = groupItems.filter((c) => pickedGroups.includes(c.wxid)).length
  const groupCount = customers.filter((c) => c.isGroup).length
  const agentOnCount = customers.filter((c) => c.isGroup && groupOn(c.wxid)).length
  const overrideCount = Object.keys(switches).length
  const togglePick = (username: string): void =>
    setPickedGroups((p) =>
      p.includes(username) ? p.filter((x) => x !== username) : [...p, username]
    )

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

      {/* 数字员工：群级自动回复的批量管理（客户页是唯一入口） */}
      <div className="cu-agentbar">
        <span className="cu-agent-title">数字员工</span>
        <span className="cu-agent-meta">
          全局默认 {defaultOn ? '开' : '关'} ·{' '}
          {defaultMode === 'shadow' ? '影子模式（只记录不发送）' : '正式模式'} · 群 {groupCount}{' '}
          个（已开 {agentOnCount}）· 单独设置 {overrideCount} 个
        </span>
        <div className="cu-agent-filters">
          {(
            [
              ['all', '全部'],
              ['group', '仅群聊'],
              ['on', '自动回复开'],
              ['off', '自动回复关']
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              className={`cu-filter${agentFilter === k ? ' is-active' : ''}`}
              onClick={() => setAgentFilter(k)}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="cu-agent-pick">
          <input
            type="checkbox"
            checked={groupItems.length > 0 && pickedOnPage === groupItems.length}
            onChange={(e) => {
              const on = e.target.checked
              const names = groupItems.map((c) => c.wxid)
              setPickedGroups((p) =>
                on ? [...new Set([...p, ...names])] : p.filter((x) => !names.includes(x))
              )
            }}
          />
          选中本页群
        </label>
        <span className="cu-agent-picked">已选 {pickedGroups.length}</span>
        <button
          type="button"
          className="cu-filter"
          disabled={savingScope || pickedGroups.length === 0}
          onClick={() => void applyScope(pickedGroups, { enabled: true })}
        >
          批量开启
        </button>
        <button
          type="button"
          className="cu-filter"
          disabled={savingScope || pickedGroups.length === 0}
          onClick={() => void applyScope(pickedGroups, { enabled: false })}
        >
          批量关闭
        </button>
        <button
          type="button"
          className="cu-filter"
          disabled={savingScope || pickedGroups.length === 0}
          onClick={() => void applyScope(pickedGroups, { reset: true })}
          title="删掉这些群的单独设置，跟随全局默认"
        >
          跟随默认
        </button>
        {pickedGroups.length > 0 && (
          <button
            type="button"
            className="cu-filter cu-filter-clear"
            onClick={() => setPickedGroups([])}
          >
            清空选择
          </button>
        )}
      </div>
      <div className="cu-list page-card">
        <div className="cu-row cu-row-head">
          <span />
          <span>客户</span>
          <span>类型</span>
          <span>状态标签</span>
          <span>最近消息</span>
          <span>最近活跃</span>
          <span>未读</span>
          <span>数字员工</span>
        </div>
        {pageItems.map((c) => (
          <div
            key={c.wxid}
            className="cu-row"
            role="button"
            tabIndex={0}
            onClick={() => setSelected(c)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setSelected(c)
              }
            }}
          >
            <span className="cu-cell-pick" onClick={(e) => e.stopPropagation()}>
              {c.isGroup ? (
                <input
                  type="checkbox"
                  checked={pickedGroups.includes(c.wxid)}
                  onChange={() => togglePick(c.wxid)}
                  aria-label={`选择 ${c.name}`}
                />
              ) : (
                <span className="cu-muted">—</span>
              )}
            </span>
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
            <span className="cu-cell-agent" onClick={(e) => e.stopPropagation()}>
              {c.isGroup ? (
                <button
                  type="button"
                  className={`cu-agent-toggle${groupOn(c.wxid) ? ' is-on' : ''}`}
                  title={
                    groupOn(c.wxid)
                      ? `自动回复已开启（${(switches[c.wxid]?.mode ?? defaultMode) === 'shadow' ? '影子模式：只记录不发送' : '正式模式'}）—— 点击关闭`
                      : '自动回复已关闭 —— 点击开启（未单独设置的群跟随全局默认）'
                  }
                  onClick={() => void applyScope([c.wxid], { enabled: !groupOn(c.wxid) })}
                  disabled={savingScope}
                >
                  {groupOn(c.wxid) ? '开' : '关'}
                  {switches[c.wxid] ? '' : '*'}
                </button>
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
