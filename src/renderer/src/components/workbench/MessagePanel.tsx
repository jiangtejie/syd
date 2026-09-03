import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { useWorkbenchStore } from '../../stores/workbench'
import { avatarColor, formatTimeDivider, needTimeDivider } from '../../lib/ui'
import type { ChatMessage, ChatRecordItem, RedEnvelopeStatus } from '../../../../shared/types'
import AttachmentViewer, { BubbleImage, type Attachment } from './AttachmentViewer'
import MessageContextMenu, { type ContextMenuState } from './MessageContextMenu'

/** 按需取头像（contact URL / head_image 本地 BLOB），带简单缓存与进行中去重；localOnly=远程 URL 已失败，强制取本地 */
const avatarCache = new Map<string, string | null>()
const avatarPending = new Map<string, Promise<string | null>>()
function fetchAvatarUrl(
  wxid: string,
  username: string,
  localOnly: boolean
): Promise<string | null> {
  const cacheKey = localOnly ? `${username}::local` : username
  if (avatarCache.has(cacheKey)) return Promise.resolve(avatarCache.get(cacheKey) ?? null)
  let p = avatarPending.get(cacheKey)
  if (!p) {
    p = (
      window.api?.cs?.wx?.getAvatar?.(wxid, username, localOnly) ??
      Promise.resolve({ ok: false as const })
    )
      .then((res) => {
        const u = res?.ok && res.url ? res.url : null
        avatarCache.set(cacheKey, u)
        return u
      })
      .catch(() => {
        avatarCache.set(cacheKey, null)
        return null
      })
      .finally(() => {
        avatarPending.delete(cacheKey)
      })
    avatarPending.set(cacheKey, p)
  }
  return p
}
function useAvatar(username?: string, localOnly = false): string | null {
  const wxid = useWorkbenchStore((s) => s.wxid)
  const source = useWorkbenchStore((s) => s.source)
  const cacheKey = username ? (localOnly ? `${username}::local` : username) : ''
  const [url, setUrl] = useState<string | null>(
    username ? (avatarCache.get(cacheKey) ?? null) : null
  )
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
    void fetchAvatarUrl(wxid, username, localOnly).then((u) => {
      if (alive) setUrl(u)
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

// 红包状态缓存：会话内一次查询，30s 内复用（对齐 CipherTalk useRedEnvelopeStatus）
const redEnvelopeCache = new Map<
  string,
  { at: number; promise: Promise<Map<string, RedEnvelopeStatus>> }
>()
function loadRedEnvelopeStatuses(
  wxid: string,
  sessionId: string
): Promise<Map<string, RedEnvelopeStatus>> {
  const key = `${wxid}::${sessionId}`
  const hit = redEnvelopeCache.get(key)
  if (hit && Date.now() - hit.at < 30_000) return hit.promise
  const promise = (
    window.api?.cs?.wx?.getRedEnvelopeStatuses?.(wxid, sessionId) ??
    Promise.resolve({ ok: true as const, statuses: [] })
  )
    .then((res) => new Map((res.ok && res.statuses ? res.statuses : []).map((r) => [r.sendId, r])))
    .catch(() => new Map<string, RedEnvelopeStatus>())
  redEnvelopeCache.set(key, { at: Date.now(), promise })
  return promise
}

/** 按 sendId 取红包本地状态（会话内一次查询，30s 缓存） */
function useRedEnvelopeStatus(
  sessionId: string,
  sendId: string | undefined
): RedEnvelopeStatus | null {
  const wxid = useWorkbenchStore((s) => s.wxid)
  const source = useWorkbenchStore((s) => s.source)
  const [status, setStatus] = useState<RedEnvelopeStatus | null>(null)
  useEffect(() => {
    let alive = true
    if (!sendId || source !== 'wx' || !wxid) {
      setStatus(null)
      return
    }
    loadRedEnvelopeStatuses(wxid, sessionId).then((map) => {
      if (alive) setStatus(map.get(sendId) ?? null)
    })
    return () => {
      alive = false
    }
  }, [sessionId, sendId, wxid, source])
  return status
}

/** 视频时长（秒）→ mm:ss */
function formatVideoDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${String(r).padStart(2, '0')}`
}

/** 聊天记录单条摘要（发送人: 内容） */
function chatRecordText(item: ChatRecordItem): string {
  const name = item.sourcename ? `${item.sourcename}: ` : ''
  const body = item.datadesc || item.datatitle
  if (body) return name + body
  const labels: Record<number, string> = {
    1: '[文本]',
    3: '[图片]',
    34: '[语音]',
    43: '[视频]',
    47: '[表情]',
    49: '[链接]'
  }
  return name + (labels[item.datatype] || '[消息]')
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

const MessageBubble = memo(function MessageBubble({
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
  onContextMenu: (
    e: React.MouseEvent,
    text: string,
    sender?: { username: string; isTeam: boolean }
  ) => void
}): React.JSX.Element {
  const isImage = message.localType === 3
  const isEmoji = message.localType === 47 && !!message.emojiCdnUrl
  const isVideo = message.localType === 43
  const isChatHistory = message.localType === 49 && !!message.chatRecordList?.length
  const isFile = message.localType === 49 && !!message.fileName && !isChatHistory
  const isRedEnvelope = message.localType === 49 && !!message.redEnvelopeSendId
  // 转账消息（49/2000）：主进程已解析付款/收款方显示名
  const isTransfer = !!message.transferPayerUsername || !!message.transferReceiverUsername
  const copyText = isFile ? message.fileName || '' : message.parsedContent
  // 动画表情加载：cdn 直显 → 失败后向主进程要本地缓存（下载/复用，ct-media）→ 再失败回落文本摘要
  const [emojiStage, setEmojiStage] = useState<'cdn' | 'local' | 'failed'>('cdn')
  const [emojiLocalUrl, setEmojiLocalUrl] = useState<string | null>(null)
  const onEmojiError = (): void => {
    if (emojiStage !== 'cdn') {
      setEmojiStage('failed')
      return
    }
    setEmojiStage('local')
    const wxid = useWorkbenchStore.getState().wxid
    if (!wxid) {
      setEmojiStage('failed')
      return
    }
    window.api?.cs?.media
      ?.resolveEmoji(wxid, {
        md5: message.emojiMd5,
        productId: message.productId,
        cdnUrl: message.emojiCdnUrl
      })
      .then((r) => {
        if (r?.ok && r.url) setEmojiLocalUrl(r.url)
        else setEmojiStage('failed')
      })
      .catch(() => setEmojiStage('failed'))
  }
  const redEnvelopeStatus = useRedEnvelopeStatus(
    sessionUsername,
    isRedEnvelope ? message.redEnvelopeSendId : undefined
  )

  const isRecv = !message.isSend
  const myAvatar = useMyAvatar()

  // 接收方身份：群聊=发送人 senderUsername；私聊=会话对方（sessionUsername）
  const recvIdentity: string | null = isRecv
    ? isGroup
      ? (message.senderUsername ?? null)
      : sessionUsername
    : null
  // 群聊发送人 enrich 头像 / 私聊会话头像（可能是远程 URL，失败后走本地 head_image 兜底）
  const enrichedRecvUrl = isRecv
    ? isGroup
      ? message.senderAvatarUrl
      : sessionAvatarUrl
    : undefined
  const [recvUrlFailed, setRecvUrlFailed] = useState(false)
  // 无 enrich URL 时按需 IPC 取（contact URL → head_image）；远程 URL 失败后强制 localOnly 取本地
  const directRecvUrl = useAvatar(recvIdentity && !enrichedRecvUrl ? recvIdentity : undefined)
  const localRecvUrl = useAvatar(
    recvIdentity && (!enrichedRecvUrl || recvUrlFailed) ? recvIdentity : undefined,
    true
  )

  // 换消息/换发送人/换会话头像后重置失败标记
  useEffect(
    () => setRecvUrlFailed(false),
    [
      message.localId,
      message.senderUsername,
      message.senderAvatarUrl,
      sessionAvatarUrl,
      sessionUsername
    ]
  )

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
      onContextMenu={(e) =>
        onContextMenu(
          e,
          copyText,
          !message.isSend && message.senderUsername
            ? { username: message.senderUsername, isTeam: !!message.senderIsTeam }
            : undefined
        )
      }
    >
      <Avatar
        name={avatarName}
        url={avatarUrl ?? undefined}
        className="wb-msg-avatar"
        onUrlError={isRecv ? () => setRecvUrlFailed(true) : undefined}
      />
      <div className="wb-msg-main">
        {showSenderName && (
          <div className="wb-msg-sender">
            {message.senderNickname}
            {message.senderIsTeam && <em className="wb-msg-sender-team">团队客服</em>}
          </div>
        )}
        <div className="wb-msg-bubble">
          {message.quotedContent && (
            <div className="wb-msg-quote">
              {message.quotedSender && (
                <div className="wb-msg-quote-sender">{message.quotedSender}</div>
              )}
              {message.quotedEmojiCdnUrl ? (
                <img
                  className="wb-msg-quote-emoji"
                  src={message.quotedEmojiCdnUrl}
                  alt=""
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="wb-msg-quote-content">{message.quotedContent}</div>
              )}
            </div>
          )}
          {isTransfer && (
            <div className="wb-msg-transfer-names">
              {message.transferPayerName ?? message.transferPayerUsername ?? '?'} →{' '}
              {message.transferReceiverName ?? message.transferReceiverUsername ?? '?'}
            </div>
          )}
          {isImage ? (
            <BubbleImage
              imageMd5={message.imageMd5}
              isLivePhoto={message.isLivePhoto}
              onOpen={() =>
                onOpenAttachment({
                  kind: 'image',
                  imageMd5: message.imageMd5
                })
              }
            />
          ) : isEmoji && emojiStage !== 'failed' ? (
            emojiStage === 'local' && !emojiLocalUrl ? (
              <span className="wb-msg-emoji-loading">表情加载中…</span>
            ) : (
              <img
                className="wb-msg-emoji"
                src={emojiStage === 'local' ? emojiLocalUrl || '' : message.emojiCdnUrl}
                alt="动画表情"
                referrerPolicy="no-referrer"
                onError={onEmojiError}
              />
            )
          ) : isVideo ? (
            <div
              className="wb-msg-video"
              onClick={() => onOpenAttachment({ kind: 'video', videoMd5: message.videoMd5 })}
            >
              <span className="wb-msg-video-icon">🎬</span>
              {message.videoDuration !== undefined && (
                <span className="wb-msg-video-dur">
                  {formatVideoDuration(message.videoDuration)}
                </span>
              )}
            </div>
          ) : isChatHistory ? (
            <div className="wb-msg-chathistory">
              <div className="wb-msg-chathistory-title">{bubbleText}</div>
              {message.chatRecordList!.slice(0, 4).map((item, i) => (
                <div className="wb-msg-chathistory-item" key={i}>
                  {chatRecordText(item)}
                </div>
              ))}
              {message.chatRecordList!.length > 4 && (
                <div className="wb-msg-chathistory-more">
                  … 共 {message.chatRecordList!.length} 条
                </div>
              )}
            </div>
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
          ) : isRedEnvelope ? (
            <div className="wb-msg-hongbao">
              <span className="wb-msg-hongbao-text">{bubbleText}</span>
              {redEnvelopeStatus && redEnvelopeStatus.receiveStatus === 2 && (
                <span className="wb-msg-hongbao-status">已领取</span>
              )}
              {redEnvelopeStatus && redEnvelopeStatus.receiveStatus !== 2 && !message.isSend && (
                <span className="wb-msg-hongbao-status">未领取</span>
              )}
            </div>
          ) : (
            <span className="wb-msg-text">{bubbleText}</span>
          )}
        </div>
      </div>
    </div>
  )
})

function MessagePanel(): React.JSX.Element {
  const activeSessionId = useWorkbenchStore((s) => s.activeSessionId)
  const sessions = useWorkbenchStore((s) => s.sessions)
  const messages = useWorkbenchStore((s) => s.messages)
  const loading = useWorkbenchStore((s) => s.loading)
  const messagesHasMore = useWorkbenchStore((s) => s.messagesHasMore)
  const loadingOlder = useWorkbenchStore((s) => s.loadingOlder)
  const loadOlder = useWorkbenchStore((s) => s.loadOlder)
  const sending = useWorkbenchStore((s) => s.sending)
  const sendText = useWorkbenchStore((s) => s.sendText)
  const bodyRef = useRef<HTMLDivElement>(null)
  const lastSessionRef = useRef<string | null>(null)
  const pendingScrollRef = useRef(false)
  const [attachment, setAttachment] = useState<Attachment | null>(null)
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null)
  const [draft, setDraft] = useState('')

  const activeSession = sessions.find((s) => s.username === activeSessionId) || null

  const handleContextMenu = useCallback(
    (
      e: React.MouseEvent,
      text: string,
      sender?: { username: string; isTeam: boolean }
    ): void => {
      if (!text && !sender) return
      e.preventDefault()
      setCtxMenu({
        x: e.clientX,
        y: e.clientY,
        text,
        senderUsername: sender?.username,
        senderIsTeam: sender?.isTeam
      })
    },
    []
  )

  // 切换会话：清空草稿 + 标记“消息加载完成后滚到底部”（消息是异步加载，此刻滚动无意义）
  useEffect(() => {
    setDraft('')
    if (lastSessionRef.current !== activeSessionId) {
      lastSessionRef.current = activeSessionId
      pendingScrollRef.current = true
    }
  }, [activeSessionId])

  // 消息更新：新会话加载完成则强制滚到底部；否则仅当用户本就在底部附近时才跟随
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    if (pendingScrollRef.current) {
      pendingScrollRef.current = false
      el.scrollTop = el.scrollHeight
      return
    }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [messages])

  // 「在聊天中定位」：滚动到目标时间对应消息并短暂高亮
  const scrollHint = useWorkbenchStore((s) => s.scrollHint)
  useEffect(() => {
    if (!scrollHint) return
    if (activeSessionId !== scrollHint.sessionId) return
    const el = bodyRef.current
    if (!el || messages.length === 0) {
      useWorkbenchStore.setState({ scrollHint: null })
      return
    }
    const items = el.querySelectorAll<HTMLElement>('.wb-msg')
    let lastIdx = -1
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].createTime <= scrollHint.targetMs) lastIdx = i
      else break
    }
    const target = lastIdx >= 0 ? Math.min(lastIdx + 1, items.length - 1) : 0
    const node = items[target]
    if (node) {
      node.scrollIntoView({ block: 'center', behavior: 'smooth' })
      node.classList.add('wb-msg-flash')
      window.setTimeout(() => node.classList.remove('wb-msg-flash'), 2400)
    }
    useWorkbenchStore.setState({ scrollHint: null })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollHint, activeSessionId, messages])

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
        {activeSession.unreadCount > 0 && (
          <span className="wb-tag wb-tag-danger">{activeSession.unreadCount} 条未读</span>
        )}
      </div>
      <div className="wb-chat-body" ref={bodyRef}>
        {loading && messages.length === 0 ? (
          <div className="wb-loading">加载中...</div>
        ) : messages.length === 0 ? (
          <div className="wb-loading">暂无消息</div>
        ) : (
          <>
            {messagesHasMore && (
              <button
                type="button"
                className="wb-load-older"
                disabled={loadingOlder}
                onClick={() => void loadOlder()}
              >
                {loadingOlder ? '加载中…' : '加载更早消息'}
              </button>
            )}
            {messages.map((m, i) => {
              const prev = i > 0 ? messages[i - 1] : null
              const showDivider = !prev || needTimeDivider(prev.createTime, m.createTime)
              return (
                <div key={m.localId || `${m.serverSeq}-${m.sortSeq}`}>
                  {showDivider && (
                    <div className="wb-time-divider">{formatTimeDivider(m.createTime)}</div>
                  )}
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
            })}
          </>
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
