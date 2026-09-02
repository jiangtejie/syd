import { useEffect, useMemo, useState } from 'react'
import { useWorkbenchStore } from '../../stores/workbench'
import { avatarColor, formatSessionTime, previewSummary } from '../../lib/ui'
import type { SessionSummary } from '../../../../shared/types'

/** 会话头像兜底：contact 无 URL，或远程 URL 加载失败时，走 IPC 取 head_image 本地头像（失败后 localOnly 强制本地，避免拿到同一个坏链接） */
const avatarCache = new Map<string, string | null>()
function useSessionAvatar(session: SessionSummary): { avatarUrl?: string; markUrlFailed: () => void } {
  const wxid = useWorkbenchStore((s) => s.wxid)
  const source = useWorkbenchStore((s) => s.source)
  const [localFallback, setLocalFallback] = useState<string | null>(null)
  const [remoteFailed, setRemoteFailed] = useState(false)
  const hasUrl = !!session.avatarUrl && /^(https?:|data:image)/.test(session.avatarUrl)

  // 换会话/换头像后重置远程加载失败状态
  useEffect(() => setRemoteFailed(false), [session.username, session.avatarUrl])

  // 无 URL 或远程 URL 失败 -> 查 head_image 本地头像；localOnly 防止远程失败后又返回同一个 URL
  const needLocal = !hasUrl || remoteFailed
  useEffect(() => {
    let alive = true
    if (!needLocal || source !== 'wx' || !wxid || !session.username) return
    const cacheKey = remoteFailed ? `${session.username}::local` : session.username
    if (avatarCache.has(cacheKey)) {
      setLocalFallback(avatarCache.get(cacheKey) ?? null)
      return
    }
    window.api?.cs?.wx
      ?.getAvatar?.(wxid, session.username, remoteFailed)
      .then((res) => {
        if (!alive) return
        const u = res?.ok && res.url ? res.url : null
        avatarCache.set(cacheKey, u)
        setLocalFallback(u)
      })
      .catch(() => {
        if (alive) avatarCache.set(cacheKey, null)
      })
    return () => {
      alive = false
    }
  }, [needLocal, remoteFailed, session.username, wxid, source])

  const avatarUrl = hasUrl && !remoteFailed ? session.avatarUrl : (localFallback ?? undefined)
  return { avatarUrl, markUrlFailed: () => setRemoteFailed(true) }
}

function SessionItem({ session, active, isChild, onSelect }: {
  session: SessionSummary
  active: boolean
  isChild?: boolean
  onSelect: (id: string) => void
}): React.JSX.Element {
  const name = session.displayName || session.username
  const { avatarUrl, markUrlFailed } = useSessionAvatar(session)
  const [imgFailed, setImgFailed] = useState(false)
  const showImg = !!avatarUrl && /^(https?:|data:image)/.test(avatarUrl) && !imgFailed
  useEffect(() => setImgFailed(false), [avatarUrl])
  const summaryText = previewSummary(session.summary)
  const sessionTime = session.lastTimestamp || session.sortTimestamp
  return (
    <div
      className={`wb-session ${active ? 'is-active' : ''} ${isChild ? 'is-child' : ''}`}
      onClick={() => onSelect(session.username)}
    >
      {showImg ? (
        <img
          className="wb-session-avatar wb-session-avatar-img"
          src={avatarUrl}
          alt={name.slice(0, 1)}
          referrerPolicy="no-referrer"
          onError={() => {
            setImgFailed(true)
            markUrlFailed()
          }}
        />
      ) : (
        <div className="wb-session-avatar" style={{ background: avatarColor(name) }}>
          {name.slice(0, 1)}
        </div>
      )}
      <div className="wb-session-body">
        <div className="wb-session-top">
          <span className="wb-session-name">
            {session.isPinned && <span className="wb-pin">📌</span>}
            {session.isGroup && <span className="wb-group-tag">群</span>}
            {name}
          </span>
          <span className="wb-session-time">{formatSessionTime(sessionTime)}</span>
        </div>
        <div className="wb-session-bottom">
          <span className="wb-session-summary">{summaryText || '暂无消息'}</span>
          {session.unreadCount > 0 && (
            <span className="wb-session-unread">{session.unreadCount > 99 ? '99+' : session.unreadCount}</span>
          )}
        </div>
      </div>
    </div>
  )
}

/** 折叠夹虚拟项（@placeholder_foldgroup）：显示聚合未读 + 最新子会话摘要 + 展开箭头 */
function FoldGroupItem({
  session,
  expanded,
  unreadTotal,
  summary,
  onToggle
}: {
  session: SessionSummary
  expanded: boolean
  unreadTotal: number
  summary: string
  onToggle: () => void
}): React.JSX.Element {
  return (
    <div className={`wb-session wb-session-foldgroup ${expanded ? 'is-expanded' : ''}`} onClick={onToggle}>
      <div className="wb-session-avatar wb-session-foldicon">🗂️</div>
      <div className="wb-session-body">
        <div className="wb-session-top">
          <span className="wb-session-name">
            <span className={`wb-fold-arrow ${expanded ? 'is-open' : ''}`}>▸</span>
            折叠的聊天
          </span>
          <span className="wb-session-time">
            {formatSessionTime(session.lastTimestamp || session.sortTimestamp)}
          </span>
        </div>
        <div className="wb-session-bottom">
          <span className="wb-session-summary">{summary}</span>
          {unreadTotal > 0 && (
            <span className="wb-session-unread">{unreadTotal > 99 ? '99+' : unreadTotal}</span>
          )}
        </div>
      </div>
    </div>
  )
}

function SessionList(): React.JSX.Element {
  const sessions = useWorkbenchStore((s) => s.sessions)
  const activeSessionId = useWorkbenchStore((s) => s.activeSessionId)
  const selectSession = useWorkbenchStore((s) => s.selectSession)
  const refreshSessions = useWorkbenchStore((s) => s.refreshSessions)
  const [keyword, setKeyword] = useState('')
  const [foldExpanded, setFoldExpanded] = useState(false)

  // 订阅微信库变化：会话库变化时刷新列表（T5 监控桥）
  useEffect(() => {
    const unsubscribe = window.api?.cs?.wx?.onDbChanged?.((payload) => {
      if (payload.info.sessionChanged) void refreshSessions()
    })
    return unsubscribe
  }, [refreshSessions])

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return sessions
    return sessions.filter((s) => {
      const hay = `${s.displayName} ${s.nickname ?? ''} ${s.remark ?? ''} ${s.alias ?? ''} ${s.summary}`.toLowerCase()
      return hay.includes(kw)
    })
  }, [sessions, keyword])

  const isSearching = keyword.trim().length > 0

  // 分组：折叠夹子会话（isCollapsed 且非虚拟项）收进折叠夹，不参与主列表
  // 主列表：置顶在前，其余（含折叠夹虚拟项）按最后消息时间(sortTimestamp)倒序
  const { pinnedItems, normalItems, foldGroup, foldChildren } = useMemo(() => {
    const children: SessionSummary[] = []
    const pinned: SessionSummary[] = []
    const normal: SessionSummary[] = []
    let fold: SessionSummary | null = null
    for (const s of filtered) {
      if (s.isFoldGroup) {
        fold = s
      } else if (s.isCollapsed) {
        children.push(s)
      } else if (s.isPinned) {
        pinned.push(s)
      } else {
        normal.push(s)
      }
    }
    const byTime = (a: SessionSummary, b: SessionSummary): number =>
      (b.sortTimestamp || b.lastTimestamp || 0) - (a.sortTimestamp || a.lastTimestamp || 0)
    pinned.sort(byTime)
    normal.sort(byTime)
    children.sort(byTime)
    // 折叠夹虚拟项按时间混排进 normal（无虚拟项但有折叠子会话时，在最前插一个锚点）
    if (fold) {
      normal.push(fold)
      normal.sort(byTime)
    }
    return { pinnedItems: pinned, normalItems: normal, foldGroup: fold, foldChildren: children }
  }, [filtered])

  // 折叠夹聚合：未读总和 + 最新子会话摘要（取首行预览）
  const foldUnreadTotal = foldChildren.reduce((sum, s) => sum + (s.unreadCount || 0), 0)
  const firstPreview = foldChildren.length > 0 ? previewSummary(foldChildren[0].summary) : ''
  const foldSummary =
    foldChildren.length === 0
      ? '暂无消息'
      : foldChildren.length === 1
        ? firstPreview || '暂无消息'
        : `${foldChildren[0].displayName || foldChildren[0].username}: ${firstPreview || '暂无消息'}`

  // 渲染行项：置顶在前，normal 按时间倒序；折叠夹虚拟项处插入折叠夹（+展开子项）
  const renderFoldGroup = (): React.JSX.Element[] => {
    const anchor = foldGroup ?? foldChildren[0]
    if (!anchor) return []
    const items: React.JSX.Element[] = [
      <FoldGroupItem
        key="__foldgroup__"
        session={anchor}
        expanded={foldExpanded}
        unreadTotal={foldUnreadTotal}
        summary={foldSummary}
        onToggle={() => setFoldExpanded((v) => !v)}
      />
    ]
    if (foldExpanded) {
      for (const c of foldChildren) {
        items.push(
          <SessionItem
            key={c.username}
            session={c}
            isChild
            active={c.username === activeSessionId}
            onSelect={(id) => void selectSession(id)}
          />
        )
      }
    }
    return items
  }

  const renderSession = (s: SessionSummary): React.JSX.Element => (
    <SessionItem
      key={s.username}
      session={s}
      active={s.username === activeSessionId}
      onSelect={(id) => void selectSession(id)}
    />
  )

  let rows: React.JSX.Element[]
  if (isSearching) {
    // 搜索时平铺所有匹配（含折叠子会话），不按组折叠
    rows = filtered.map(renderSession)
  } else {
    rows = []
    for (const s of pinnedItems) rows.push(renderSession(s))
    for (const s of normalItems) {
      if (s.isFoldGroup) {
        rows.push(...renderFoldGroup())
      } else {
        rows.push(renderSession(s))
      }
    }
    // 无折叠夹虚拟项但有折叠子会话：折叠夹附在列表末尾
    if (!foldGroup && foldChildren.length > 0) rows.push(...renderFoldGroup())
  }

  return (
    <div className="wb-session-list">
      <div className="wb-session-header">会话（{sessions.length}）</div>
      <div className="wb-session-search">
        <input
          className="wb-session-search-input"
          placeholder="搜索会话"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
      </div>
      {rows}
      {filtered.length === 0 && (
        <div className="wb-empty">
          {keyword ? '没有匹配的会话' : '暂无会话，请先在 设置 → 微信数据与密钥 连接'}
        </div>
      )}
    </div>
  )
}

export default SessionList
