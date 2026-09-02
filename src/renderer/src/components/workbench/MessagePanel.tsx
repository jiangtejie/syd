import { useEffect, useRef, useState } from 'react'
import { useWorkbenchStore } from '../../stores/workbench'
import { avatarColor, formatTimeDivider, needTimeDivider } from '../../lib/ui'
import type { ChatMessage } from '../../../../shared/types'
import AttachmentViewer, {
  PLACEHOLDER_IMAGE_URL,
  useDecryptImage,
  type Attachment
} from './AttachmentViewer'
import MessageContextMenu, { type ContextMenuState } from './MessageContextMenu'

/** 按需取头像（contact URL / head_image 本地 BLOB），带简单缓存；localOnly=远程 URL 已失败，强制取本地 */
const avatarCache = new Map<string, string | null>()
function useAvatar(username?: string, localOnly = false): string | null {
  const wxid = useWorkbenchStore((s) => s.wxid)
  const source = useWorkbenchStore((s) => s.source)
  const cacheKey = username ? (localOnly ? `${username}::local` : username) : ''
  const [url, setUrl] = useState<string | null>(username ? (avatarCache.get(cacheKey) ?? null) : null)
  useEffect(() => {
    let alive = true
    if (!username || source !== 'wx' || !wxid) {
      setUrl(null)
      return
    }
    if (avatarCache.has(cacheKey)) {
      setUrl(avatarCache.get(cacheKey) ?? null)
      return
    }
    window.api?.cs?.wx
      ?.getAvatar?.(wxid, username, localOnly)
      .then((res) => {
        if (!alive) return
        const u = res?.ok && res.url ? res.url : null
        avatarCache.set(cacheKey, u)
        setUrl(u)
      })
      .catch(() => {
        if (alive) avatarCache.set(cacheKey, null)
      })
    return () => {
      alive = false
    }
  }, [username, wxid, source, cacheKey, localOnly])
  return url
}

/** 当前登录 wxid（发送方头像用） */
function useMyAvatar(): string | null {
  const wxid = useWorkbenchStore((s) => s.wxid)
  return useAvatar(wxid || undefined)
}

/**
 * 消息面板（T6/T8）：会话头部 + 消息气泡列表（可滚动）+ 人工输入发送。
 */

/** 头像：有 URL（http/data:image）用 img，加载失败/无 URL 时用首字占位；onUrlError 供外层换本地兜底 */
function Avatar({
  name,
  url,
  className,
  onUrlError
}: {
  name: string
  url?: string
  className: string
  onUrlError?: () => void
}): React.JSX.Element {
  const label = (name || '?').slice(0, 1)
  const [failed, setFailed] = useState(false)
  const showImg = !!url && /^(https?:|data:image)/.test(url) && !failed
  // url 变化时重置失败状态（切会话/换人/换成本地兜底图后重试加载）
  useEffect(() => setFailed(false), [url])
  if (showImg) {
    return (
      <img
        className={`${className} ${className}-img`}
        src={url}
        alt={label}
        referrerPolicy="no-referrer"
        onError={() => {
          setFailed(true)
          onUrlError?.()
        }}
      />
    )
  }
  return (
    <div className={className} style={{ background: avatarColor(label) }}>
      {label}
    </div>
  )
}

function MessageBubble({
  message,
  isGroup,
  sessionAvatarUrl,
  sessionName,
  sessionUsername,
  onOpenAttachment,
  onContextMenu
}: {
  message: ChatMessage
  isGroup: boolean
  sessionAvatarUrl?: string
  sessionName: string
  sessionUsername: string
  onOpenAttachment: (att: Attachment) => void
  onContextMenu: (e: React.MouseEvent, text: string) => void
}): React.JSX.Element {
  const isImage = message.localType === 3
  const isFile = message.localType === 49 && !!message.fileName
  const copyText = isFile ? message.fileName || '' : message.parsedContent
  const { url: imgUrl } = useDecryptImage(isImage ? message.imageMd5 : undefined, 'thumb')

  const isRecv = !message.isSend
  const myAvatar = useMyAvatar()

  // 接收方身份：群聊=发送人 senderUsername；私聊=会话对方（sessionUsername）
  const recvIdentity: string | null = isRecv ? (isGroup ? message.senderUsername ?? null : sessionUsername) : null
  // 群聊发送人 enrich 头像 / 私聊会话头像（可能是远程 URL，失败后走本地 head_image 兜底）
  const enrichedRecvUrl = isRecv ? (isGroup ? message.senderAvatarUrl : sessionAvatarUrl) : undefined
  const [recvUrlFailed, setRecvUrlFailed] = useState(false)
  // 无 enrich URL 时按需 IPC 取（contact URL → head_image）；远程 URL 失败后强制 localOnly 取本地
  const directRecvUrl = useAvatar(recvIdentity && !enrichedRecvUrl ? recvIdentity : undefined)
  const localRecvUrl = useAvatar(recvIdentity && (!enrichedRecvUrl || recvUrlFailed) ? recvIdentity : undefined, true)

  // 换消息/换发送人/换会话头像后重置失败标记
  useEffect(() => setRecvUrlFailed(false), [
    message.localId,
    message.senderUsername,
    message.senderAvatarUrl,
    sessionAvatarUrl,
    sessionUsername
  ])

  // 头像与昵称：群聊且接收 → 发送人昵称/头像；私聊接收 → 会话头像/名；发送 → “我”
  const avatarName = isRecv
    ? isGroup
      ? message.senderNickname || message.senderUsername || sessionName
      : sessionName
    : '我'
  let avatarUrl: string | null = null
  if (isRecv) {
    const primary = !recvUrlFailed ? (enrichedRecvUrl ?? directRecvUrl) : null
    avatarUrl = primary ?? localRecvUrl
  } else {
    avatarUrl = myAvatar
  }
  // 群聊接收消息显示发送人昵称；私聊/自己发的不重复显示
  const showSenderName = isGroup && isRecv && !!message.senderNickname

  // 系统消息（撤回/入群等系统提示）：居中灰条，无气泡无头像
  const isSystem = message.localType === 10000
  if (isSystem) {
    return (
      <div className="wb-msg-system">
        <span className="wb-msg-system-text">{message.parsedContent}</span>
      </div>
    )
  }

  // 语音消息附时长（如 [语音] 8″），无内容时兜底类型占位
  let bubbleText = message.parsedContent
  if (message.localType === 34 && message.voiceDuration) {
    bubbleText = `[语音] ${Math.max(1, Math.round(message.voiceDuration / 1000))}″`
  }
  if (!bubbleText) bubbleText = '[消息]'

  return (
    <div
      className={`wb-msg ${message.isSend ? 'is-send' : 'is-recv'}`}
      onContextMenu={(e) => onContextMenu(e, copyText)}
    >
      <Avatar
        name={avatarName}
        url={avatarUrl ?? undefined}
        className="wb-msg-avatar"
        onUrlError={isRecv ? () => setRecvUrlFailed(true) : undefined}
      />
      <div className="wb-msg-main">
        {showSenderName && <div className="wb-msg-sender">{message.senderNickname}</div>}
        <div className="wb-msg-bubble">
          {isImage ? (
            <img
              className="wb-msg-image"
              src={imgUrl || PLACEHOLDER_IMAGE_URL}
              alt="图片消息"
              onClick={() =>
                onOpenAttachment({
                  kind: 'image',
                  url: imgUrl ?? undefined,
                  imageMd5: message.imageMd5
                })
              }
            />
          ) : isFile ? (
            <div
              className="wb-msg-file"
              onClick={() =>
                onOpenAttachment({
                  kind: 'file',
                  fileName: message.fileName!,
                  fileSize: message.fileSize
                })
              }
            >
              <span className="wb-msg-file-icon">📄</span>
              <div className="wb-msg-file-meta">
                <div className="wb-msg-file-name">{message.fileName}</div>
                {message.fileSize !== undefined && (
                  <div className="wb-msg-file-size">
                    {(message.fileSize / 1024 / 1024).toFixed(2)} MB
                  </div>
                )}
              </div>
            </div>
          ) : (
            <span className="wb-msg-text">{bubbleText}</span>
          )}
        </div>
      </div>
    </div>
  )
}

function MessagePanel(): React.JSX.Element {
  const activeSessionId = useWorkbenchStore((s) => s.activeSessionId)
  const sessions = useWorkbenchStore((s) => s.sessions)
  const messages = useWorkbenchStore((s) => s.messages)
  const loading = useWorkbenchStore((s) => s.loading)
  const sending = useWorkbenchStore((s) => s.sending)
  const sendText = useWorkbenchStore((s) => s.sendText)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [attachment, setAttachment] = useState<Attachment | null>(null)
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null)
  const [draft, setDraft] = useState('')

  const activeSession = sessions.find((s) => s.username === activeSessionId) || null

  const handleContextMenu = (e: React.MouseEvent, text: string): void => {
    if (!text) return
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY, text })
  }

  // 切换会话：滚到底部 + 清空草稿（避免误发到其他会话）
  useEffect(() => {
    setDraft('')
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [activeSessionId])

  // 新消息：仅当用户本就在底部附近时才自动跟随，浏览历史时不打断
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [messages])

  const handleSend = (): void => {
    const text = draft.trim()
    if (!text || sending) return
    setDraft('')
    void sendText(text, 'manual')
  }

  if (!activeSession) {
    return (
      <div className="wb-chat-empty">
        <div className="wb-chat-empty-title">微信私域智能客服</div>
        <div className="wb-chat-empty-sub">从左侧选择一个会话开始</div>
      </div>
    )
  }

  return (
    <div className="wb-chat-panel">
      <div className="wb-chat-header">
        <span className="wb-chat-name">{activeSession.displayName || activeSession.username}</span>
        {activeSession.isWeCom && <span className="wb-tag">企微</span>}
        {activeSession.isOfficialAccount && <span className="wb-tag">公众号</span>}
        {activeSession.unreadCount > 0 && <span className="wb-tag">{activeSession.unreadCount} 条未读</span>}
      </div>
      <div className="wb-chat-body" ref={bodyRef}>
        {loading && messages.length === 0 ? (
          <div className="wb-loading">加载中...</div>
        ) : messages.length === 0 ? (
          <div className="wb-loading">暂无消息</div>
        ) : (
          messages.map((m, i) => {
            const prev = i > 0 ? messages[i - 1] : null
            const showDivider = !prev || needTimeDivider(prev.createTime, m.createTime)
            return (
              <div key={m.localId || `${m.serverSeq}-${m.sortSeq}`}>
                {showDivider && <div className="wb-time-divider">{formatTimeDivider(m.createTime)}</div>}
                <MessageBubble
                  message={m}
                  isGroup={activeSession.isGroup}
                  sessionAvatarUrl={activeSession.avatarUrl}
                  sessionName={activeSession.displayName || activeSession.username}
                  sessionUsername={activeSession.username}
                  onOpenAttachment={setAttachment}
                  onContextMenu={handleContextMenu}
                />
              </div>
            )
          })
        )}
      </div>
      <div className="wb-chat-input">
        <textarea
          className="wb-chat-textarea"
          placeholder="输入人工回复，Enter 发送，Shift+Enter 换行"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSend()
            }
          }}
        />
        <button
          type="button"
          className="wb-chat-send"
          disabled={sending || !draft.trim()}
          onClick={handleSend}
        >
          {sending ? '发送中…' : '发送'}
        </button>
      </div>
      {attachment && (
        <AttachmentViewer attachment={attachment} onClose={() => setAttachment(null)} />
      )}
      {ctxMenu && <MessageContextMenu state={ctxMenu} onClose={() => setCtxMenu(null)} />}
    </div>
  )
}

export default MessagePanel
