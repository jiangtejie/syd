import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkbenchStore } from '../../stores/workbench'
import { avatarColor, formatTimeDivider, needTimeDivider } from '../../lib/ui'
import type { ChatMessage, ChatRecordItem, RedEnvelopeStatus } from '../../../../shared/types'
import AttachmentViewer, { BubbleImage, type Attachment } from './AttachmentViewer'
import MessageContextMenu, { type ContextMenuState } from './MessageContextMenu'
import { SkeletonLines, EmptyHint } from './placeholders'
import { toast } from '../../stores/toast'
import { APP_NAME } from '../../../../shared/appInfo'

const dialogApi = window.api?.cs?.dialog

/** 待发送文件条目(会话输入区选择后排队发送) */
interface PendingFile {
  path: string
  name: string
  kind: 'image' | 'file'
}

const MAX_PENDING = 8
const IMAGE_FILTER = {
  name: '图片',
  extensions: ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp']
}

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
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 会话/账号切换时清空头像(全仓同款模式)
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
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 切会话/账号时清空红包状态(全仓同款模式)
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
/**
 * 语音消息（localType 34）：点击才向主进程要 WAV（VoiceInfo 取 SILK → 解码 → 缓存），
 * 避免打开聊天页就对整屏语音做解码。
 *
 * 播放条是自绘的，不用 <audio controls>：原生控件在气泡里压不住宽度（进度条被裁一截、
 * 时长挤成两个小字），观感也和微信气泡完全不搭。自绘之后波形进度、拖拽定位、时间显示
 * 都由我们说了算，配合协议侧的 Range 响应，进度条是真的能拖动的。
 */

/** 播放 / 暂停 / 重试图标（内联 SVG：不引图标库、不用字体符号，缩放不糊） */
function IconPlay(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <path d="M8.6 5.3v13.4L19 12z" fill="currentColor" />
    </svg>
  )
}

function IconPause(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <rect x="7" y="5.5" width="3.4" height="13" rx="1.1" fill="currentColor" />
      <rect x="13.6" y="5.5" width="3.4" height="13" rx="1.1" fill="currentColor" />
    </svg>
  )
}

function IconRetry(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <path
        d="M19.2 12a7.2 7.2 0 1 1-2.6-5.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <path d="M17.6 2.4l.7 4.7-4.7.7z" fill="currentColor" />
    </svg>
  )
}

/**
 * 波形柱高度（百分比）。用消息 id 做种子而不是随机数：同一段语音每次重渲染都得是同一个形状，
 * 否则播放中每次 state 更新整排柱子都会跳一下。
 */
function voiceWaveHeights(seed: string, count = 26): number[] {
  let h = 2166136261
  for (let i = 0; i < seed.length; i += 1) {
    h = Math.imul(h ^ seed.charCodeAt(i), 16777619)
  }
  const out: number[] = []
  for (let i = 0; i < count; i += 1) {
    h ^= h >>> 15
    h = Math.imul(h, 2246822507)
    h ^= h >>> 13
    h = Math.imul(h, 3266489909)
    h ^= h >>> 16
    const r = (h >>> 0) / 4294967296
    // 两端收窄、中间饱满：一排等高的柱子看着像进度条，不像语音
    const shape = 0.5 + 0.5 * Math.sin(((i + 0.5) / count) * Math.PI)
    out.push(Math.round(32 + r * 40 + shape * 28))
  }
  return out
}

/** 秒 → m:ss（语音基本不会超 1 小时，超了也顺手支持 h:mm:ss） */
function formatClock(sec: number): string {
  const total = Math.max(0, Math.floor(sec))
  const s = total % 60
  const m = Math.floor(total / 60)
  if (m < 60) return m + ':' + String(s).padStart(2, '0')
  return (
    Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0') + ':' + String(s).padStart(2, '0')
  )
}

function VoiceBubble({ message }: { message: ChatMessage }): React.JSX.Element {
  const [stage, setStage] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  // 已转写内容：查询层会把缓存的转写并进 parsedContent（形如 [语音] 8″ 文本），这里也支持现转（腾讯云 ASR）
  const [text, setText] = useState<string | null>(transcriptOf(message.parsedContent))
  const [asr, setAsr] = useState<'idle' | 'running' | 'failed'>('idle')
  const [asrError, setAsrError] = useState('')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  // 解码是异步的：点播放/拖进度时音频还没就绪，先把意图存下来，metadata 到了再兑现
  const wantPlayRef = useRef(false)
  const pendingSeekRef = useRef<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  /** 拖拽中的预览比例（null = 没在拖） */
  const [scrub, setScrub] = useState<number | null>(null)
  /** 解码后读到的真实时长（秒）：消息里没有 voiceDuration 时兜底 */
  const [mediaSec, setMediaSec] = useState(0)

  const msgSeconds = message.voiceDuration
    ? Math.max(1, Math.round(message.voiceDuration / 1000))
    : 0
  const totalSeconds = msgSeconds || mediaSec
  const wave = useMemo(
    () =>
      voiceWaveHeights(String(message.serverId || message.localId || message.createTime || 'v')),
    [message.serverId, message.localId, message.createTime]
  )

  const transcribe = (): void => {
    if (asr === 'running') return
    const wxid = useWorkbenchStore.getState().wxid
    if (!wxid) {
      setAsr('failed')
      setAsrError('未选择账号')
      return
    }
    setAsr('running')
    setAsrError('')
    window.api?.cs?.media
      ?.voiceTranscript(wxid, {
        serverId: message.serverId,
        localId: message.localId,
        createTime: message.createTime
      })
      .then((r) => {
        if (r?.ok && r.text) {
          setText(r.text)
          setAsr('idle')
        } else {
          setAsr('failed')
          setAsrError(r?.error || '转写失败')
        }
      })
      .catch((e: unknown) => {
        setAsr('failed')
        setAsrError(e instanceof Error ? e.message : String(e))
      })
  }

  /** 取 WAV（必要时开播）。seekRatio 用于「还没解码就先拖了进度条」：解码完直接跳到那儿 */
  const load = (autoPlay: boolean, seekRatio: number | null = null): void => {
    if (stage === 'loading' || stage === 'ready') return
    const wxid = useWorkbenchStore.getState().wxid
    if (!wxid) {
      setStage('failed')
      setError('未选择账号')
      return
    }
    wantPlayRef.current = autoPlay
    pendingSeekRef.current = seekRatio
    setStage('loading')
    setError('')
    window.api?.cs?.media
      ?.voiceWav(wxid, {
        serverId: message.serverId,
        localId: message.localId,
        createTime: message.createTime
      })
      .then((r) => {
        if (r?.ok && r.url) {
          setUrl(r.url)
          setStage('ready')
        } else {
          setError(r?.error || '语音解码失败')
          setStage('failed')
        }
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e))
        setStage('failed')
      })
  }

  /** 定位到某个比例（0..1）：UI 与 audio.currentTime 一起走 */
  const seekToRatio = (ratio: number, durationHint?: number): void => {
    const el = audioRef.current
    const dur =
      durationHint ??
      (el && Number.isFinite(el.duration) && el.duration > 0 ? el.duration : totalSeconds)
    const r = Math.min(1, Math.max(0, ratio))
    setProgress(r)
    if (dur > 0) setElapsed(r * dur)
    if (!el || !Number.isFinite(el.duration) || el.duration <= 0) return
    // 留 50ms 余量：正好设成 duration 会被浏览器弹回 0，表现为「一拖到末尾就重播」
    el.currentTime = Math.min(r * el.duration, Math.max(el.duration - 0.05, 0))
  }

  /** metadata/可播放：补真实时长，并兑现「待定位」「待播放」两个意图 */
  const onReady = (): void => {
    const el = audioRef.current
    if (!el) return
    const dur = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0
    if (dur > 0) {
      setMediaSec(dur)
      const ratio = pendingSeekRef.current
      if (ratio !== null) {
        pendingSeekRef.current = null
        seekToRatio(ratio, dur)
      }
    }
    if (wantPlayRef.current) {
      wantPlayRef.current = false
      el.play().catch(() => setPlaying(false))
    }
  }

  const toggle = (): void => {
    if (stage === 'idle' || stage === 'failed') {
      load(true)
      return
    }
    if (stage === 'loading') return
    const el = audioRef.current
    if (!el) return
    if (el.paused) el.play().catch(() => setPlaying(false))
    else el.pause()
  }

  const ratioAt = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return 0
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
  }

  const onTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    e.currentTarget.focus()
    e.currentTarget.setPointerCapture(e.pointerId)
    const ratio = ratioAt(e.clientX)
    setScrub(ratio)
    // 还没解码就先拖：记下位置，解码完直接跳过去（不自动开播）
    if (stage === 'idle' || stage === 'failed') load(false, ratio)
  }

  const onTrackPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (scrub === null) return
    setScrub(ratioAt(e.clientX))
  }

  const onTrackPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (scrub === null) return
    const ratio = ratioAt(e.clientX)
    setScrub(null)
    if (stage === 'ready') seekToRatio(ratio)
    else pendingSeekRef.current = ratio
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* 已经释放过：忽略 */
    }
  }

  const onTrackKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = 5 / (totalSeconds || 1)
    if (e.key === 'ArrowRight') seekToRatio(progress + step)
    else if (e.key === 'ArrowLeft') seekToRatio(progress - step)
    else if (e.key === 'Home') seekToRatio(0)
    else if (e.key === 'End') seekToRatio(1)
    else return
    e.preventDefault()
  }

  const shownRatio = scrub ?? progress
  const shownSeconds = scrub !== null ? scrub * totalSeconds : elapsed
  const playTitle =
    stage === 'loading'
      ? '正在解码语音…'
      : stage === 'failed'
        ? '解码失败，点击重试' + (error ? '：' + error : '')
        : playing
          ? '暂停'
          : '播放'

  /** 转写区：有文本就展示，没有就给入口。转写中 / 失败都收敛在这一个按钮上 */
  const transcriptNode = text ? (
    <p className="wb-msg-voice-text" title="腾讯云 ASR 转写文本">
      {text}
    </p>
  ) : (
    <>
      <button
        type="button"
        className="wb-msg-voice-asr"
        onClick={transcribe}
        disabled={asr === 'running'}
        title="用腾讯云一句话识别转写这条语音（需在设置里配置 SecretId/SecretKey）"
      >
        {asr === 'running' ? (
          <>
            <span className="wb-msg-voice-spin is-dark" aria-hidden="true" />
            转写中…
          </>
        ) : (
          <>
            <span className="wb-msg-voice-asr-glyph" aria-hidden="true">
              文
            </span>
            转写为文字
          </>
        )}
      </button>
      {asr === 'failed' && asrError && (
        <span className="wb-msg-voice-err">转写失败：{asrError}</span>
      )}
    </>
  )

  return (
    <div className="wb-msg-voice">
      <div
        className="wb-msg-voice-head"
        // 气泡宽度跟着语音长度走：短语音不必撑成一条，长语音也不该挤成一小坨
        style={{ minWidth: 172 + Math.min(68, msgSeconds * 6) }}
      >
        <button
          type="button"
          className={
            'wb-msg-voice-play' +
            (playing ? ' is-playing' : '') +
            (stage === 'failed' ? ' is-failed' : '')
          }
          onClick={toggle}
          disabled={stage === 'loading'}
          title={playTitle}
          aria-label={playTitle}
        >
          {stage === 'loading' ? (
            <span className="wb-msg-voice-spin" aria-hidden="true" />
          ) : stage === 'failed' ? (
            <IconRetry />
          ) : playing ? (
            <IconPause />
          ) : (
            <IconPlay />
          )}
        </button>
        <div
          ref={trackRef}
          className="wb-msg-voice-wave"
          role="slider"
          tabIndex={0}
          aria-label="语音进度"
          aria-valuemin={0}
          aria-valuemax={Math.round(totalSeconds)}
          aria-valuenow={Math.round(shownSeconds)}
          title="点击或拖拽定位"
          onPointerDown={onTrackPointerDown}
          onPointerMove={onTrackPointerMove}
          onPointerUp={onTrackPointerUp}
          onPointerCancel={onTrackPointerUp}
          onKeyDown={onTrackKeyDown}
        >
          {wave.map((h, i) => (
            <span
              key={i}
              className={
                'wb-msg-voice-bar' + (i + 0.5 <= shownRatio * wave.length ? ' is-played' : '')
              }
              style={{ height: h + '%' }}
            />
          ))}
        </div>
        <span className="wb-msg-voice-time">
          {totalSeconds > 0
            ? formatClock(shownSeconds) + ' / ' + formatClock(totalSeconds)
            : formatClock(shownSeconds)}
        </span>
      </div>
      {stage === 'ready' && url && (
        <audio
          ref={audioRef}
          className="wb-msg-voice-audio"
          src={url}
          preload="auto"
          onLoadedMetadata={onReady}
          onCanPlay={onReady}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={() => {
            const el = audioRef.current
            if (!el) return
            setElapsed(el.currentTime)
            if (Number.isFinite(el.duration) && el.duration > 0) {
              setProgress(Math.min(1, el.currentTime / el.duration))
            }
          }}
          onEnded={() => {
            setPlaying(false)
            setProgress(0)
            setElapsed(0)
          }}
          onError={() => {
            setPlaying(false)
            setError('音频加载失败')
            setStage('failed')
          }}
        />
      )}
      {stage === 'failed' && error && <span className="wb-msg-voice-err">播放失败：{error}</span>}
      {transcriptNode}
    </div>
  )
}

/** 从 parsedContent 里取出「已转写的语音内容」（没有则返回 null） */
function transcriptOf(parsedContent: string | undefined): string | null {
  if (!parsedContent) return null
  const m = /^\[语音\](?:\s*\d+″)?\s*(.+)$/.exec(parsedContent.trim())
  return m?.[1]?.trim() || null
}

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
  // eslint-disable-next-line react-hooks/set-state-in-effect -- url 切换即重置图片失败标记(全仓同款模式)
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
  const isVoice = message.localType === 34
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 消息切换即重置头像失败标记(全仓同款模式)
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
  if (message.localType === 34) {
    // 语音气泡由 VoiceBubble 渲染（播放 + 转写），这里只在没有转写文本时给占位
    bubbleText = transcriptOf(message.parsedContent) ?? ''
    if (!bubbleText && message.voiceDuration) {
      bubbleText = `[语音] ${Math.max(1, Math.round(message.voiceDuration / 1000))}″`
    }
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
          ) : isVoice ? (
            <VoiceBubble message={message} />
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
  const sendFile = useWorkbenchStore((s) => s.sendFile)
  const bodyRef = useRef<HTMLDivElement>(null)
  const lastSessionRef = useRef<string | null>(null)
  const pendingScrollRef = useRef(false)
  const [attachment, setAttachment] = useState<Attachment | null>(null)
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null)
  const [draft, setDraft] = useState('')
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([])
  const [sendLabel, setSendLabel] = useState('')
  const [attachMenu, setAttachMenu] = useState(false)

  const activeSession = sessions.find((s) => s.username === activeSessionId) || null

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, text: string, sender?: { username: string; isTeam: boolean }): void => {
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

  // 切换会话：清空草稿与待发文件 + 标记“消息加载完成后滚到底部”（消息是异步加载，此刻滚动无意义）
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 会话切换清空草稿与待发列表(全仓同款模式)
    setDraft('')
    setPendingFiles([])
    setAttachMenu(false)
    if (lastSessionRef.current !== activeSessionId) {
      lastSessionRef.current = activeSessionId
      pendingScrollRef.current = true
    }
  }, [activeSessionId])

  // 消息更新：新会话加载完成则强制滚到底部；翻页加载保持视口锚点；否则仅当用户本就在底部附近时才跟随
  const anchorGapRef = useRef<number | null>(null)
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    if (pendingScrollRef.current) {
      pendingScrollRef.current = false
      el.scrollTop = el.scrollHeight
      return
    }
    // 顶部翻页后:内容在顶部插入,按「距底距离不变」恢复视口,避免跳变
    if (anchorGapRef.current !== null) {
      el.scrollTop = el.scrollHeight - anchorGapRef.current
      anchorGapRef.current = null
      return
    }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [messages])

  /** 加载更早一页(记录当前距底距离,翻页后恢复视口位置) */
  const requestOlder = (): void => {
    const el = bodyRef.current
    if (el && anchorGapRef.current === null) {
      anchorGapRef.current = el.scrollHeight - el.scrollTop
    }
    void loadOlder()
  }

  /** 滚到接近顶部时自动加载更早历史(loadingOlder/是否还有更多由 store 状态兜底) */
  const onBodyScroll = (): void => {
    const el = bodyRef.current
    if (!el || messagesHasMore === false || loadingOlder || loading) return
    if (el.scrollTop <= 64) requestOlder()
  }

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
    const targetMs = scrollHint.targetMs
    // 命中取点：优先「第一条 >= 目标时间」的消息（与问题首条证据同秒的消息簇取最早一条，避免跳过证据）；
    // 目标早于已加载窗口 → 定位到最早一条；晚于窗口 → 最新一条。
    let idx = -1
    if (messages.length > 0) {
      if (targetMs < messages[0].createTime) {
        idx = 0
      } else if (targetMs > messages[messages.length - 1].createTime) {
        idx = messages.length - 1
      } else {
        for (let i = 0; i < messages.length; i++) {
          if (messages[i].createTime >= targetMs) {
            idx = i
            break
          }
        }
      }
    }
    const target = idx >= 0 ? idx : 0
    const node = items[target]
    if (node) {
      node.scrollIntoView({ block: 'center', behavior: 'smooth' })
      node.classList.add('wb-msg-flash')
      window.setTimeout(() => node.classList.remove('wb-msg-flash'), 2400)
    }
    useWorkbenchStore.setState({ scrollHint: null })
  }, [scrollHint, activeSessionId, messages])

  /** 追加待发文件(去重,总数上限) */
  const addPendingFiles = (paths: string[], kind: 'image' | 'file'): void => {
    setPendingFiles((prev) => {
      const next = [...prev]
      for (const p of paths) {
        if (next.length >= MAX_PENDING) {
          toast.error(`一次最多发送 ${MAX_PENDING} 个文件`)
          break
        }
        if (next.some((f) => f.path === p)) continue
        const name = p.split(/[\\/]/).pop() || p
        next.push({ path: p, name, kind })
      }
      return next
    })
  }

  const pickImages = async (): Promise<void> => {
    const r = await dialogApi
      ?.pickFiles({ title: '选择要发送的图片（可多选）', multi: true, filters: [IMAGE_FILTER] })
      .catch(() => null)
    if (r?.ok && r.paths && r.paths.length > 0) addPendingFiles(r.paths, 'image')
  }

  const pickAnyFiles = async (): Promise<void> => {
    const r = await dialogApi
      ?.pickFiles({ title: '选择要发送的文件（可多选）', multi: true })
      .catch(() => null)
    if (r?.ok && r.paths && r.paths.length > 0) addPendingFiles(r.paths, 'file')
  }

  const removePending = (path: string): void => {
    setPendingFiles((prev) => prev.filter((f) => f.path !== path))
  }

  const handleSend = async (): Promise<void> => {
    const text = draft.trim()
    if (sending || (!text && pendingFiles.length === 0)) return
    const files = pendingFiles
    setDraft('')
    setPendingFiles([])
    setSendLabel(text ? '发送文本…' : '')
    if (text) await sendText(text, 'manual')
    for (const f of files) {
      if (!activeSessionId) break
      setSendLabel(`发送${f.kind === 'image' ? '图片' : '文件'}:${f.name}…`)
      await sendFile(f.path, f.kind)
    }
    setSendLabel('')
  }

  /**
   * 消息行元素缓存:输入草稿/待发附件等 state 变化时元素引用不变,
   * React 会直接跳过这棵子树的协调(数百条消息时,每次按键重建 750 个包裹元素是主要开销)。
   */
  const listItems = useMemo(() => {
    const sess = activeSession
    if (!sess) return null
    return messages.map((m, i) => {
      const prev = i > 0 ? messages[i - 1] : null
      const showDivider = !prev || needTimeDivider(prev.createTime, m.createTime)
      return (
        <div key={m.localId || `${m.serverSeq}-${m.sortSeq}`}>
          {showDivider && <div className="wb-time-divider">{formatTimeDivider(m.createTime)}</div>}
          <MessageBubble
            message={m}
            isGroup={sess.isGroup}
            sessionAvatarUrl={sess.avatarUrl}
            sessionName={sess.displayName || sess.username}
            sessionUsername={sess.username}
            onOpenAttachment={setAttachment}
            onContextMenu={handleContextMenu}
          />
        </div>
      )
    })
  }, [messages, activeSession, handleContextMenu])

  if (!activeSession) {
    return (
      <div className="wb-chat-empty">
        <div className="wb-chat-empty-title">{APP_NAME}</div>
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
      <div className="wb-chat-body" ref={bodyRef} onScroll={onBodyScroll}>
        {loading && messages.length === 0 ? (
          <SkeletonLines rows={4} />
        ) : messages.length === 0 ? (
          <EmptyHint
            icon="💬"
            title="暂无消息"
            desc="本会话还没有可展示的消息;对方发言后会自动刷新。"
          />
        ) : (
          <>
            {messagesHasMore ? (
              <button
                type="button"
                className="wb-load-older"
                disabled={loadingOlder}
                onClick={requestOlder}
              >
                {loadingOlder ? '正在加载更早消息…' : '加载更早消息（上滑自动加载）'}
              </button>
            ) : (
              <div className="wb-history-end">已是最早消息</div>
            )}
            {listItems}
          </>
        )}
      </div>
      <div className="wb-chat-input">
        <div className="wb-chat-composer">
          {pendingFiles.length > 0 && (
            <div className="wb-chat-pending">
              {pendingFiles.map((f) => (
                <span key={f.path} className="wb-chat-pchip">
                  <span className="wb-chat-pchip-kind">{f.kind === 'image' ? '图片' : '文件'}</span>
                  <b title={f.path}>{f.name}</b>
                  <button type="button" title="移除" onClick={() => removePending(f.path)}>
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
          {sendLabel && <div className="wb-chat-status">{sendLabel}</div>}
          <div className="wb-chat-composer-row">
            {/* 附件入口:⊕ 弹出 图片/文件(主流布局:附件居左、正文居中、发送居右) */}
            <div className="wb-chat-attach-wrap">
              <button
                type="button"
                className="wb-chat-attach"
                title="添加图片或文件"
                aria-label="添加附件"
                aria-expanded={attachMenu}
                disabled={sending || !activeSession}
                onClick={() => setAttachMenu((v) => !v)}
              >
                <span className="wb-chat-attach-plus">＋</span>
              </button>
              {attachMenu && (
                <>
                  <div className="wb-chat-menu-mask" onClick={() => setAttachMenu(false)} />
                  <div className="wb-chat-attach-menu" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      disabled={sending}
                      onClick={() => {
                        setAttachMenu(false)
                        void pickImages()
                      }}
                    >
                      🖼 图片
                      <span>png/jpg/jpeg/bmp/gif/webp,可多选</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={sending}
                      onClick={() => {
                        setAttachMenu(false)
                        void pickAnyFiles()
                      }}
                    >
                      📎 文件
                      <span>pdf/office/压缩包等,可多选</span>
                    </button>
                    <div className="wb-chat-attach-tip">
                      发送需微信窗口在前台;图片按图片粘贴,其余按文件发送
                    </div>
                  </div>
                </>
              )}
            </div>
            <textarea
              className="wb-chat-textarea"
              placeholder="输入人工回复，Enter 发送，Shift+Enter 换行"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void handleSend()
                }
              }}
            />
            <button
              type="button"
              className="wb-chat-send"
              disabled={sending || (!draft.trim() && pendingFiles.length === 0)}
              onClick={() => void handleSend()}
            >
              {sending
                ? '发送中…'
                : pendingFiles.length > 0 && !draft.trim()
                  ? `发送(${pendingFiles.length})`
                  : '发送'}
            </button>
          </div>
        </div>
      </div>
      {attachment && (
        <AttachmentViewer attachment={attachment} onClose={() => setAttachment(null)} />
      )}
      {ctxMenu && <MessageContextMenu state={ctxMenu} onClose={() => setCtxMenu(null)} />}
    </div>
  )
}

export default MessagePanel
