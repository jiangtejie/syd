import { useCallback, useEffect, useMemo, useState } from 'react'
import { useWorkbenchStore } from '../stores/workbench'
import { avatarColor, formatSessionTime } from '../lib/ui'
import { useSessionAvatar } from '../lib/sessionAvatar'
import { deriveCustomers, secondaryLabel, TAG_ORDER, type CustomerProfile } from '../lib/customers'
import { toast } from '../stores/toast'
import ConnectGuide from '../components/ConnectGuide'
import type { DutyGroupSwitch } from '../../../shared/types'
import type { CustomerStored } from '../../../shared/customerProfile'
import './customers.css'
import { useAsyncEffect } from '../lib/useAsyncEffect'

/**
 * 客户页：私域客户列表（状态标签筛选）+ 画像抽屉。
 * 列表与标签全部来自微信真实会话数据（未读/最后消息时间/会话类型/置顶），无示例算法。
 */

/** 每页条数选项 */
const PAGE_SIZES = [10, 20, 50, 100]

/**
 * 状态标签 → ui-chip 语气。
 * 列表与抽屉共用同一套映射：同一个标签在任何位置颜色一致，颜色本身就能读状态。
 * （超时未回=红 / 待回复=琥珀 / 近期互动=绿 / 其余=中性）
 */
function statusTone(tag: string): string {
  if (tag === '超时未回') return 'is-bad is-line'
  if (tag === '待回复') return 'is-warn is-line'
  if (tag === '今日互动' || tag === '近7日互动') return 'is-ok is-line'
  return ''
}

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
  wxid,
  onSaved,
  onClose
}: {
  customer: CustomerProfile
  /** 账号（档案按账号作用域存） */
  wxid: string
  onSaved: () => void | Promise<void>
  onClose: () => void
}): React.JSX.Element {
  const gotoSession = useWorkbenchStore((s) => s.gotoSession)
  // 表单初值来自客户；调用方用 key={wxid} 保证换客户时重挂载（否则会残留上一个客户的草稿）
  const [source, setSource] = useState(customer.source)
  const [note, setNote] = useState(customer.note)
  const [newTag, setNewTag] = useState('')
  const [busy, setBusy] = useState(false)

  const api = window.api?.cs?.customers

  const saveFields = async (): Promise<void> => {
    if (!api?.setFields || !wxid) return
    setBusy(true)
    try {
      const res = await api.setFields(wxid, customer.wxid, { source, note })
      if (!res.ok) {
        toast.error(res.error || '保存失败')
        return
      }
      toast.success('已保存到客户档案')
      await onSaved()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  const addTag = async (): Promise<void> => {
    const tag = newTag.trim()
    if (!api?.setTag || !wxid || !tag) return
    setBusy(true)
    try {
      const res = await api.setTag(wxid, customer.wxid, tag)
      if (!res.ok) {
        toast.error(res.error || '打标签失败')
        return
      }
      setNewTag('')
      await onSaved()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '打标签失败')
    } finally {
      setBusy(false)
    }
  }

  const removeTag = async (tag: string): Promise<void> => {
    if (!api?.removeTag || !wxid) return
    try {
      const res = await api.removeTag(wxid, customer.wxid, tag)
      if (!res.ok) {
        toast.error(res.error || '删除标签失败')
        return
      }
      await onSaved()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除标签失败')
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="cu-drawer-mask" onClick={onClose}>
      <aside className="cu-drawer" onClick={(e) => e.stopPropagation()}>
        <header className="cu-drawer-head">
          <CustomerAvatar profile={customer} size="lg" />
          <div className="cu-drawer-title">
            <div className="cu-name-row">
              <span className="cu-name">{customer.name}</span>
              <span className={`ui-chip is-sm${customer.isGroup ? ' is-line cu-kind-group' : ''}`}>
                {customer.isGroup ? '群聊' : '个人'}
              </span>
              {customer.unreadCount > 0 && (
                <span className="cu-unread ui-num">{customer.unreadCount}</span>
              )}
            </div>
            <div className="cu-wxid ui-num">{customer.wxid}</div>
          </div>
          <button
            type="button"
            className="ui-btn is-ghost is-sm cu-drawer-close"
            onClick={onClose}
            aria-label="关闭客户画像"
          >
            ✕
          </button>
        </header>

        <div className="cu-drawer-body">
          <section className="cu-section">
            <div className="ui-label cu-section-title">状态标签</div>
            <div className="cu-tags">
              {customer.statusTags.map((t) => (
                <span key={t} className={`ui-chip is-sm ${statusTone(t)}`}>
                  {t}
                </span>
              ))}
            </div>
          </section>

          <section className="cu-section">
            <div className="ui-label cu-section-title">资料</div>
            <div className="cu-kv">
              <span>备注</span>
              <span>{customer.remark || '—'}</span>
            </div>
            <div className="cu-kv">
              <span>微信昵称</span>
              <span>{customer.nickname || '—'}</span>
            </div>
          </section>

          <section className="cu-section">
            <div className="ui-label cu-section-title">活跃情况</div>
            <div className="cu-kv">
              <span>最近活跃</span>
              <span className="ui-num">{formatSessionTime(customer.lastActive)}</span>
            </div>
            <div className="cu-kv">
              <span>未读消息</span>
              <span className="ui-num">{customer.unreadCount}</span>
            </div>
            <div className="cu-kv cu-kv-block">
              <span>最近消息</span>
              <span className="cu-summary-cell">{customer.summary || '—'}</span>
            </div>
          </section>

          <section className="cu-section">
            <div className="ui-label cu-section-title">客户档案</div>
            <div className="cu-kv">
              <span>建档时间</span>
              <span className="ui-num">
                {customer.firstSeenAt ? formatSessionTime(customer.firstSeenAt) : '未建档'}
              </span>
            </div>
            <label className="cu-field">
              <span>来源</span>
              <input
                className="ui-input"
                value={source}
                disabled={busy}
                placeholder={'如：抖音探店视频 / 门店扫码 / 老客介绍'}
                onChange={(e) => setSource(e.target.value)}
              />
            </label>
            <label className="cu-field">
              <span>内部备注</span>
              <textarea
                className="ui-textarea"
                rows={2}
                value={note}
                disabled={busy}
                placeholder={'大客户 / 账期客户 / 慎报价…（微信备注里放不下这些）'}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="ui-btn is-primary cu-save"
              disabled={busy || (source === customer.source && note === customer.note)}
              onClick={() => void saveFields()}
            >
              {busy ? '保存中…' : '保存来源与备注'}
            </button>

            <div className="ui-label cu-section-title cu-sub-title">
              人工标签 <span className="ui-num">{customer.manualTags.length}</span>
            </div>
            <div className="cu-tags">
              {customer.manualTags.length === 0 && (
                <span className="cu-hint-inline">还没有人工标签</span>
              )}
              {customer.manualTags.map((t) => (
                <span key={t} className="ui-chip is-sm is-warn cu-manual-tag">
                  {t}
                  <button
                    type="button"
                    title={'删除标签'}
                    className="cu-tag-x"
                    onClick={() => void removeTag(t)}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
            <div className="cu-tag-add">
              <input
                className="ui-input"
                value={newTag}
                disabled={busy}
                placeholder={'打一个标签（回车添加）'}
                onChange={(e) => setNewTag(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void addTag()
                }}
              />
              <button
                type="button"
                className="ui-btn"
                disabled={busy || newTag.trim() === ''}
                onClick={() => void addTag()}
              >
                添加
              </button>
            </div>
            <div className="cu-drawer-hint">
              来源与标签是「触达目标筛选」和「营销归因」的依据 —— 微信里没有这两个字段，只有这里有。
            </div>
          </section>
        </div>

        <footer className="cu-drawer-foot">
          <button
            type="button"
            className="ui-btn is-primary cu-goto"
            onClick={() => {
              onClose()
              gotoSession(customer.wxid)
            }}
          >
            进入会话
          </button>
          <div className="cu-drawer-hint">标签基于微信会话数据（未读/时间/类型）实时判断</div>
        </footer>
      </aside>
    </div>
  )
}

function CustomersPage(): React.JSX.Element {
  const sessions = useWorkbenchStore((s) => s.sessions)
  const source = useWorkbenchStore((s) => s.source)
  const refreshSessions = useWorkbenchStore((s) => s.refreshSessions)
  /** 跳到「值班」页（那里是话术/决策记录，同一个数字员工状态） */
  const gotoPage = useWorkbenchStore((s) => s.setPage)
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [jumpValue, setJumpValue] = useState('')
  /** 抽屉里展示哪个客户:只记 id,渲染时从实时列表取(见下方 selected) */
  const [selectedId, setSelectedId] = useState<string | null>(null)
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

  useAsyncEffect(loadSwitches, [loadSwitches])

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

  // ── 客户档案（持久层）──
  // 会话是微信给的实时列表，档案是我们自己攒的（来源/备注/人工标签）。
  // 先 sync 把微信侧事实并进来（幂等、不碰用户字段），再 list 取回合并。
  const [storedProfiles, setStoredProfiles] = useState<Map<string, CustomerStored>>(new Map())
  const reloadProfiles = useCallback(async (): Promise<void> => {
    const api = window.api?.cs?.customers
    if (!api || !wxid) return
    await api.sync(wxid).catch(() => null)
    const res = await api.list(wxid).catch(() => null)
    if (res?.ok && res.items) {
      setStoredProfiles(new Map(res.items.map((i) => [i.username, i])))
    }
  }, [wxid])

  // 档案只随「用户改动 / 账号切换」变化，不必跟着每条新消息刷新
  useAsyncEffect(reloadProfiles, [reloadProfiles])

  const customers = useMemo(
    () => deriveCustomers(sessions, nowMs, storedProfiles),
    [sessions, nowMs, storedProfiles]
  )

  /**
   * 抽屉的客户按 id 从**实时列表**取:
   * 之前存的是对象快照 —— 列表刷新后抽屉还显示旧数据;客户消失(清空数据/会话被删)时抽屉也不关。
   * 现在客户不存在就自然变成 null,抽屉自己收起来。
   */
  const selected = useMemo(
    () => (selectedId ? (customers.find((c) => c.wxid === selectedId) ?? null) : null),
    [selectedId, customers]
  )

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

  // 注: 原 replyCount（待回复人数）只被页头那行统计用过；统计已并进筛选胶囊，
  // 胶囊上的数字由 tagCounts 直接渲染，这里不再需要一份中间变量。
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
    <div className="page-scroll cu-page">
      {/* 页头：左侧标题 + 右侧 HUD 读数。统计只出现在这里与筛选胶囊上，不另起一行。 */}
      <div className="cu-head">
        <div className="cu-head-main">
          <h2 className="page-title">客户</h2>
          <span className="cu-head-meta">标签由微信数据实时判断 · 档案随会话自动并档</span>
        </div>
        <div className="cu-hud" aria-label="客户概览">
          <div className="cu-hud-item">
            <span className="cu-hud-k">客户总数</span>
            <span className="cu-hud-v ui-num">{customers.length}</span>
          </div>
          <div className="cu-hud-item">
            <span className="cu-hud-k">待回复</span>
            <span className="cu-hud-v ui-num cu-hud-warn">{tagCounts.get('待回复') ?? 0}</span>
          </div>
          <div className="cu-hud-item">
            <span className="cu-hud-k">群聊</span>
            <span className="cu-hud-v ui-num">{groupCount}</span>
          </div>
          <div className="cu-hud-item">
            <span className="cu-hud-k">单聊</span>
            <span className="cu-hud-v ui-num">{customers.length - groupCount}</span>
          </div>
        </div>
      </div>

      <div className="cu-toolbar">
        <div className="cu-search-wrap">
          <svg
            className="cu-search-icon"
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.4" />
          </svg>
          <input
            className="ui-input cu-search"
            placeholder="搜索客户名 / 备注 / wxid / 标签"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>
        <div className="cu-filters">
          <button
            type="button"
            className={`ui-pill cu-filter${effectiveTag === null ? ' is-on' : ''}`}
            onClick={() => setTagFilter(null)}
          >
            全部
            <span className="cu-filter-n ui-num">{customers.length}</span>
          </button>
          {tagOptions.map((t) => (
            <button
              key={t}
              type="button"
              className={`ui-pill cu-filter${effectiveTag === t ? ' is-on' : ''}`}
              onClick={() => setTagFilter(effectiveTag === t ? null : t)}
            >
              {t}
              <span className="cu-filter-n ui-num">{tagCounts.get(t)}</span>
            </button>
          ))}
          {hasFilters && (
            <button
              type="button"
              className="ui-btn is-ghost is-sm cu-filter-clear"
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

      {/* 数字员工：群级自动回复的「批量」管理入口（总开关/话术/决策记录在「值班」页，两处是同一份状态） */}
      <div className="cu-agentbar">
        <div className="cu-agent-head">
          <span className="ui-label">数字员工</span>
          {/* 状态压成一行：完整口径放 title */}
          <span
            className="cu-agent-meta"
            title={
              '全局默认 ' +
              (defaultOn ? '开' : '关') +
              ' · ' +
              (defaultMode === 'shadow' ? '影子模式（只记录不发送）' : '正式模式') +
              ' · 群 ' +
              String(groupCount) +
              ' 个（已开 ' +
              String(agentOnCount) +
              '）· 单独设置 ' +
              String(overrideCount) +
              ' 个'
            }
          >
            全局默认 {defaultOn ? '开' : '关'} ·{' '}
            {defaultMode === 'shadow' ? '影子模式' : '正式模式'} · 已开{' '}
            <b className="ui-num">{agentOnCount}</b>/<b className="ui-num">{groupCount}</b> 个群 ·
            单独设置 <b className="ui-num">{overrideCount}</b> 个
          </span>
          <button
            type="button"
            className="ui-link cu-agent-goto"
            onClick={() => gotoPage('duty')}
            title="这里管的是「按群批量开关」；总开关、话术库与决策记录在「值班」页（同一份状态）"
          >
            话术与决策记录 →
          </button>
        </div>
        <div className="cu-agent-actions">
          <div className="ui-seg cu-agent-seg" role="group" aria-label="按自动回复筛选客户">
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
                className={`ui-seg-btn${agentFilter === k ? ' is-on' : ''}`}
                onClick={() => setAgentFilter(k)}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="cu-agent-gap" />
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
          <span className="cu-agent-picked">
            已选 <b className="ui-num">{pickedGroups.length}</b>
          </span>
          <button
            type="button"
            className="ui-btn is-sm cu-agent-batch"
            disabled={savingScope || pickedGroups.length === 0}
            onClick={() => void applyScope(pickedGroups, { enabled: true })}
          >
            批量开启
          </button>
          <button
            type="button"
            className="ui-btn is-sm cu-agent-batch"
            disabled={savingScope || pickedGroups.length === 0}
            onClick={() => void applyScope(pickedGroups, { enabled: false })}
          >
            批量关闭
          </button>
          <button
            type="button"
            className="ui-btn is-sm is-ghost cu-agent-batch"
            disabled={savingScope || pickedGroups.length === 0}
            onClick={() => void applyScope(pickedGroups, { reset: true })}
            title="删掉这些群的单独设置，跟随全局默认"
          >
            跟随默认
          </button>
          {pickedGroups.length > 0 && (
            <button
              type="button"
              className="ui-btn is-sm is-ghost cu-agent-batch"
              onClick={() => setPickedGroups([])}
            >
              清空选择
            </button>
          )}
        </div>
      </div>
      <div className="cu-list page-card">
        <div className="cu-row cu-row-head">
          <span className="cu-cell-pick" />
          <span>客户</span>
          <span>类型</span>
          <span>状态标签</span>
          <span>最近消息</span>
          <span className="cu-th-num">最近活跃</span>
          <span className="cu-th-num">未读</span>
          <span>数字员工</span>
        </div>
        {pageItems.map((c) => {
          // 类型标签（群聊/个人）已经在「类型」列里，状态列只展示真正的状态，避免同一行说两遍
          const statusOnly = c.statusTags.filter((t) => t !== '群聊' && t !== '个人')
          return (
            <div
              key={c.wxid}
              className={`cu-row${pickedGroups.includes(c.wxid) ? ' is-picked' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => setSelectedId(c.wxid)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setSelectedId(c.wxid)
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
              <span className="cu-cell-kind">
                <span
                  className={`ui-chip is-sm cu-kind-chip${c.isGroup ? ' is-line cu-kind-group' : ''}`}
                >
                  {c.isGroup ? '群聊' : '个人'}
                </span>
              </span>
              <span className="cu-cell-tags">
                {statusOnly.slice(0, 2).map((t) => (
                  <span key={t} className={`ui-chip is-sm cu-status-chip ${statusTone(t)}`}>
                    {t}
                  </span>
                ))}
                {statusOnly.length > 2 && (
                  <span className="cu-muted cu-tag-more">+{statusOnly.length - 2}</span>
                )}
                {statusOnly.length === 0 && <span className="cu-muted">—</span>}
              </span>
              <span className="cu-cell-sum" title={c.summary || undefined}>
                {c.summary || '—'}
              </span>
              <span className="cu-time ui-num">{formatSessionTime(c.lastActive)}</span>
              <span className="cu-cell-unread">
                {c.unreadCount > 0 ? (
                  <span className="cu-unread ui-num">{c.unreadCount}</span>
                ) : (
                  <span className="cu-muted">—</span>
                )}
              </span>
              <span className="cu-cell-agent" onClick={(e) => e.stopPropagation()}>
                {c.isGroup ? (
                  <button
                    type="button"
                    className={`ui-pill cu-agent-toggle${groupOn(c.wxid) ? ' is-on' : ''}`}
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
          )
        })}
        {filtered.length === 0 &&
          (hasFilters ? (
            <div className="ui-empty cu-empty">
              <span className="ui-empty-glyph">
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.5" />
                  <path d="m13 13 4 4" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              </span>
              <div className="ui-empty-title">没有匹配的客户</div>
              <div className="ui-empty-desc">
                当前筛选条件{effectiveTag ? `（标签：${effectiveTag}）` : ''}
                下没有客户，换个标签或清空条件再试。
              </div>
              <button
                type="button"
                className="ui-btn is-sm"
                onClick={() => {
                  setKeyword('')
                  setTagFilter(null)
                }}
              >
                清空条件
              </button>
            </div>
          ) : source === 'empty' ? (
            <ConnectGuide what="客户列表与他们的档案（来源/备注/标签）" />
          ) : (
            <div className="ui-empty cu-empty">
              <span className="ui-empty-glyph">
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path
                    d="M3 5.5h14v9H3z"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinejoin="round"
                  />
                  <path d="M3 9h14" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              </span>
              <div className="ui-empty-title">当前账号还没有会话数据</div>
              <div className="ui-empty-desc">
                客户列表由微信会话实时派生：在微信里产生会话后，这里会自动出现客户与状态标签。
              </div>
            </div>
          ))}
        {totalPages > 1 && (
          <div className="cu-pager">
            <span className="cu-pager-info">
              共 <b className="ui-num">{filtered.length}</b> 条 · 每页{' '}
              <b className="ui-num">{pageSize}</b> 条
            </span>
            <div className="cu-pager-ctrl">
              <select
                className="ui-select cu-pager-select"
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
                className="ui-btn is-sm cu-pager-btn"
                disabled={curPage <= 1}
                onClick={() => goPage(curPage - 1)}
              >
                ‹ 上一页
              </button>
              <span className="cu-pager-now">
                第 <b className="ui-num">{curPage}</b> / <b className="ui-num">{totalPages}</b> 页
              </span>
              <button
                type="button"
                className="ui-btn is-sm cu-pager-btn"
                disabled={curPage >= totalPages}
                onClick={() => goPage(curPage + 1)}
              >
                下一页 ›
              </button>
              <div className="cu-pager-jump">
                <input
                  className="ui-input cu-pager-jump-input"
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
                  className="ui-btn is-sm cu-pager-btn"
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

      {selected && (
        <ProfileDrawer
          key={selected.wxid}
          customer={selected}
          wxid={wxid ?? ''}
          onSaved={reloadProfiles}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  )
}

export default CustomersPage
