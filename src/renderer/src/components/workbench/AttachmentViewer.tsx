import { useCallback, useEffect, useRef, useState } from 'react'
import {
  degradedReasonText,
  tierLabel,
  type ImageDegradedReason,
  type ImageKind,
  type ImageTier
} from '../../../../shared/imageTier'
import {
  clampScale,
  displaySize,
  fitScale,
  normalizeNatural,
  previewViewport,
  type Size
} from '../../lib/imageFit'
import { useWorkbenchStore } from '../../stores/workbench'

export interface Attachment {
  kind: 'image' | 'file' | 'video'
  url?: string
  /** 图片消息的 md5（解密层可用时经 cs:media:decryptImage 获取真实图） */
  imageMd5?: string
  /** 视频消息的文件名 md5（经 cs:media:decryptVideo 解密播放） */
  videoMd5?: string
  fileName?: string
  fileSize?: number
}

/**
 * 图片兜底（仅查看大图时用）。早期版本用内联 SVG data URI 占位，浅色底图在深色主题下会糊成一块白；
 * 现在不再有占位图 URL：真图取不到时直接渲染 .wb-img-box-empty + .wb-img-hint（纯 DOM，两套主题都成立）。
 */

/** 一次解密的结果：URL + 实际命中的档位（界面要如实标注，别把缩略图当原图展示） */
interface DecryptImageOutcome {
  url: string | null
  tier?: ImageTier
  /** 降级原因（如 ffmpeg 缺失）：界面据此给出可执行提示，而不只是把徽标标成「缩略图」 */
  degradedReason?: ImageDegradedReason
}

/**
 * 解密请求缓存 + 进行中去重：同一 (wxid, md5, kind) 只发一次 IPC，
 * 已成功/失败的结果直接复用，避免列表重复气泡与反复切会话造成主进程重复扫描解密。
 * 缓存值为 {url:null}（已尝试但失败/无此资源）或 {url, tier}。
 */
const decryptUrlCache = new Map<string, DecryptImageOutcome>()
const decryptPending = new Map<string, Promise<DecryptImageOutcome>>()

function decryptKey(wxid: string, imageMd5: string, kind: ImageKind): string {
  return `${wxid}::${imageMd5}::${kind}`
}

function requestDecryptImage(
  wxid: string,
  imageMd5: string,
  kind: ImageKind
): Promise<DecryptImageOutcome> {
  const key = decryptKey(wxid, imageMd5, kind)
  const cached = decryptUrlCache.get(key)
  if (cached) return Promise.resolve(cached)
  let p = decryptPending.get(key)
  if (!p) {
    const media = window.api?.cs?.media
    p = (media?.decryptImage({ wxid, imageMd5, kind }) ?? Promise.resolve({ ok: false as const }))
      .then((res) => {
        const outcome: DecryptImageOutcome =
          res.ok && res.url
            ? { url: res.url, tier: res.foundKind, degradedReason: res.degradedReason }
            : { url: null, degradedReason: res.degradedReason }
        decryptUrlCache.set(key, outcome)
        return outcome
      })
      .catch(() => {
        const outcome: DecryptImageOutcome = { url: null }
        decryptUrlCache.set(key, outcome)
        return outcome
      })
      .finally(() => {
        decryptPending.delete(key)
      })
    decryptPending.set(key, p)
  }
  return p
}

const videoUrlCache = new Map<string, string | null>()
const videoPending = new Map<string, Promise<string | null>>()

function requestDecryptVideo(wxid: string, videoMd5: string): Promise<string | null> {
  const key = `${wxid}::${videoMd5}`
  if (videoUrlCache.has(key)) return Promise.resolve(videoUrlCache.get(key) ?? null)
  let p = videoPending.get(key)
  if (!p) {
    const media = window.api?.cs?.media
    p = (media?.decryptVideo({ wxid, videoMd5 }) ?? Promise.resolve({ ok: false as const }))
      .then((res) => {
        const u = res.ok && res.url ? res.url : null
        videoUrlCache.set(key, u)
        return u
      })
      .catch(() => {
        videoUrlCache.set(key, null)
        return null
      })
      .finally(() => {
        videoPending.delete(key)
      })
    videoPending.set(key, p)
  }
  return p
}

/**
 * 图片消息解密 hook：真实微信数据（source=wx）且带 imageMd5 时，
 * 调 cs:media:decryptImage 拉取真实图 URL（走上面的缓存/去重）；mock / 无 md5 时保持 null。
 * imageMd5 传 undefined 即表示“暂不解密”（懒加载场景由外层进入视口后再传值）。
 * kind 默认 best（高清原图 → 默认图 → 缩略图），并回传实际命中档位供界面标注。
 */
function useDecryptImage(
  imageMd5?: string,
  kind: ImageKind = 'best'
): {
  url: string | null
  busy: boolean
  tier: ImageTier | null
  degradedReason: ImageDegradedReason | null
} {
  const wxid = useWorkbenchStore((s) => s.wxid)
  const source = useWorkbenchStore((s) => s.source)
  const [url, setUrl] = useState<string | null>(null)
  const [tier, setTier] = useState<ImageTier | null>(null)
  const [degradedReason, setDegradedReason] = useState<ImageDegradedReason | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 切换 md5/账号时先清空上一张图,避免异步返回后串图
    setUrl(null)
    // 档位/降级原因与新图同步清空,避免上一张的标注留在新图上（同一段 effect 里 setUrl 已带 disable,这里无需重复）
    setTier(null)
    setDegradedReason(null)
    if (!imageMd5 || source !== 'wx' || !wxid) {
      setBusy(false)
      return () => {
        alive = false
      }
    }
    const media = window.api?.cs?.media
    if (!media) {
      setBusy(false)
      return () => {
        alive = false
      }
    }
    const key = decryptKey(wxid, imageMd5, kind)
    // 已缓存（含已失败 {url:null}）：同步取，不重复发 IPC
    const hit = decryptUrlCache.get(key)
    if (hit) {
      setUrl(hit.url)
      setTier(hit.tier ?? null)
      setDegradedReason(hit.degradedReason ?? null)
      setBusy(false)
      return () => {
        alive = false
      }
    }
    setBusy(true)
    void requestDecryptImage(wxid, imageMd5, kind).then((outcome) => {
      if (alive) {
        setUrl(outcome.url)
        setTier(outcome.tier ?? null)
        setDegradedReason(outcome.degradedReason ?? null)
        setBusy(false)
      }
    })
    return () => {
      alive = false
    }
  }, [imageMd5, wxid, source, kind])

  return { url, busy, tier, degradedReason }
}

/**
 * 视频消息解密 hook：调 cs:media:decryptVideo 解密出可播放的 ct-media:// URL（缓存/去重同上）。
 */
function useDecryptVideo(videoMd5?: string): { url: string | null; busy: boolean } {
  const wxid = useWorkbenchStore((s) => s.wxid)
  const source = useWorkbenchStore((s) => s.source)
  const [url, setUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 切换 md5/账号时先清空上一个视频,避免异步返回后串流
    setUrl(null)
    if (!videoMd5 || source !== 'wx' || !wxid) {
      setBusy(false)
      return () => {
        alive = false
      }
    }
    const media = window.api?.cs?.media
    if (!media) {
      setBusy(false)
      return () => {
        alive = false
      }
    }
    const key = `${wxid}::${videoMd5}`
    if (videoUrlCache.has(key)) {
      setUrl(videoUrlCache.get(key) ?? null)
      setBusy(false)
      return () => {
        alive = false
      }
    }
    setBusy(true)
    void requestDecryptVideo(wxid, videoMd5).then((u) => {
      if (alive) {
        setUrl(u)
        setBusy(false)
      }
    })
    return () => {
      alive = false
    }
  }, [videoMd5, wxid, source])

  return { url, busy }
}

/**
 * 消息列表中的图片缩略图（视口懒加载）：
 * 已缓存的图立即展示；未缓存的等滚动接近视口（rootMargin 220px）才发起解密，
 * 避免打开含大量图片的历史会话时一次性触发 N 个解密 IPC。
 * 加载中/失败/未近视口时显示本地占位块（不再加载外网占位图）。
 */
export function BubbleImage({
  imageMd5,
  isLivePhoto,
  onOpen
}: {
  imageMd5?: string
  isLivePhoto?: boolean
  onOpen: () => void
}): React.JSX.Element {
  const wxid = useWorkbenchStore((s) => s.wxid)
  const source = useWorkbenchStore((s) => s.source)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const active = !!imageMd5 && !!wxid && source === 'wx'
  // 缓存命中（含已失败）无需等视口，直接走缓存/失败态
  const [near, setNear] = useState<boolean>(
    () =>
      !!imageMd5 &&
      !!wxid &&
      source === 'wx' &&
      decryptUrlCache.has(decryptKey(wxid, imageMd5, 'thumb'))
  )

  useEffect(() => {
    if (near || !active) return
    const el = wrapRef.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((en) => en.isIntersecting)) {
          setNear(true)
          io.disconnect()
        }
      },
      { rootMargin: '220px 0px' }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [near, active])

  const { url, busy } = useDecryptImage(near ? imageMd5 : undefined, 'thumb')

  return (
    <div className="wb-msg-image-wrap" ref={wrapRef} onClick={onOpen}>
      {url ? (
        <img className="wb-msg-image" src={url} alt="图片消息" />
      ) : busy ? (
        <div className="wb-msg-image-ph">图片加载中…</div>
      ) : (
        <div className="wb-msg-image-ph">图片</div>
      )}
      {isLivePhoto && <span className="wb-msg-live">LIVE</span>}
    </div>
  )
}

/** 视频播放子组件（独立组件以合规调用 useDecryptVideo） */
function VideoPlayer({ videoMd5 }: { videoMd5?: string }): React.JSX.Element {
  const { url, busy } = useDecryptVideo(videoMd5)
  if (busy) return <div className="wb-att-video-hint">视频加载中…</div>
  if (!url) return <div className="wb-att-video-hint">视频加载失败或原文件已被清理</div>
  return <video className="wb-att-video" src={url} controls autoPlay />
}

const STEP = 0.1

/**
 * 档位说明：让同事知道「为什么这张不清楚」以及怎么才能拿到更好的档 ——
 * 高清原图要在微信里点开这张图并选「查看原图」才会下载到本机，随后重开预览自动升级。
 */
function tierHint(
  tier: ImageTier | null | undefined,
  degradedReason?: ImageDegradedReason | null
): string {
  if (!tier) return '未能取到本地图片档位'
  // 可修复的降级（如没配 ffmpeg）优先说清楚——这比「只有缩略图」有用得多
  if (degradedReason) return degradedReasonText(degradedReason)
  if (tier === 'hd') return '本地已落地的高清原图'
  return `本地只有${tierLabel(tier)}：在微信里点开这张图并选「查看原图」后，回这里重开即可自动用上高清原图`
}

/**
 * 可缩放图片预览：大图按窗口等比缩放到放得下；小图自动放大到合适尺寸(≤2.6x)。
 * 交互:滚轮 = 缩放,双击 = 切换 100%/自适应,顶部显示缩放比例并可重置。
 * 工具栏同时标注实际命中档位（高清原图/默认图/缩略图）—— 解密层的降级不再静默。
 *
 * **几何一律走 imageFit 纯函数**：原始尺寸与 src 绑定（换图必须重测），显示宽高由「原图宽高 × 同一个缩放系数」
 * 得出 —— 曾经的写法把上一张图（本地占位图 360×480）的尺寸配到下一张真图上，横图会被拉成 3:4 变形。
 */
function ImagePreviewer({
  src,
  tier,
  degradedReason,
  loading
}: {
  src: string
  tier?: ImageTier | null
  /** 降级原因：有值时在工具栏下方直接给出可执行的修复建议 */
  degradedReason?: ImageDegradedReason | null
  /** 真图还在解密：显示中性提示，不渲染占位图（避免「图片暂时无法预览」的字样闪一下） */
  loading?: boolean
}): React.JSX.Element {
  const [scale, setScale] = useState(1)
  const [autoFit, setAutoFit] = useState(true)
  const [meta, setMeta] = useState<{ src: string; size: Size } | null>(null)
  const [failed, setFailed] = useState(false)
  // 只有「当前这张 src」量出来的尺寸才算数；src 一变自然尺寸立刻作废，等新图 onLoad 重测
  const natural = meta && meta.src === src ? meta.size : null
  const shown = natural ? displaySize(natural, scale) : null

  const applyFit = useCallback((size: Size): void => {
    setScale(fitScale(size, previewViewport(window.innerWidth, window.innerHeight)))
    setAutoFit(true)
  }, [])

  // 窗口尺寸变了（桌面端拖窗口很常见）→ 自适应状态下重新算比例
  useEffect(() => {
    if (!natural || !autoFit) return
    const onResize = (): void => {
      setScale(fitScale(natural, previewViewport(window.innerWidth, window.innerHeight)))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [natural, autoFit])

  const zoom = (delta: number): void => {
    setScale((prev) => clampScale(prev + delta))
    setAutoFit(false)
  }

  const toggleSize = (): void => {
    if (!natural) return
    if (autoFit) {
      // 自适应 → 实际大小 100%
      setScale(1)
      setAutoFit(false)
    } else {
      applyFit(natural)
    }
  }

  const pct = Math.round(scale * 100)

  return (
    <div className="wb-img-preview">
      {loading && !failed ? (
        <div className="wb-img-box wb-img-box-empty">
          <div className="wb-img-hint">图片解密中…</div>
        </div>
      ) : failed || !src ? (
        <div className="wb-img-box wb-img-box-empty">
          <div className="wb-img-hint">
            图片加载失败：本地缓存可能已被清理，重开会话会自动重新解密
          </div>
        </div>
      ) : (
        <div
          className="wb-img-box"
          onWheel={(e) => {
            // 滚轮=缩放(预览聚焦缩放更顺手);Ctrl+滚轮同
            e.preventDefault()
            zoom(e.deltaY < 0 ? STEP : -STEP)
          }}
          onDoubleClick={toggleSize}
        >
          <img
            className="wb-img-el"
            src={src}
            alt="图片预览"
            // 尺寸未知时不写死宽高，交给 CSS 约束；已知时按「原图尺寸 × 缩放」渲染，宽高比恒定
            style={shown ? { width: shown.w, height: shown.h } : undefined}
            onLoad={(e) => {
              const img = e.currentTarget
              const size = normalizeNatural(img.naturalWidth, img.naturalHeight)
              setMeta({ src, size })
              setFailed(false)
              applyFit(size)
            }}
            onError={() => setFailed(true)}
            onWheel={(e) => e.stopPropagation()}
          />
        </div>
      )}
      <div className="wb-img-toolbar">
        <span
          className={`wb-img-tier${tier ? (tier === 'hd' ? ' is-hd' : ' is-degraded') : ''}`}
          title={tierHint(tier, degradedReason)}
        >
          {tierLabel(tier)}
        </span>
        <button type="button" className="wb-img-btn" onClick={() => zoom(-STEP * 2)} title="缩小">
          −
        </button>
        <button
          type="button"
          className="wb-img-pct"
          onClick={() => natural && applyFit(natural)}
          title="双击图片或点击回到自适应"
        >
          {pct}%
        </button>
        <button type="button" className="wb-img-btn" onClick={() => zoom(STEP * 2)} title="放大">
          +
        </button>
        <button
          type="button"
          className="wb-img-btn"
          onClick={() => natural && applyFit(natural)}
          title="适应窗口"
        >
          ⤢ 适应
        </button>
      </div>
      {degradedReason && <div className="wb-img-degrade">{degradedReasonText(degradedReason)}</div>}
    </div>
  )
}

/**
 * 附件查看弹层（T6）。
 * image：展示图片预览；file：展示文件信息（打开/导出待 M3 接入媒体解密）。
 * 交互：点击遮罩 / Esc 关闭。
 */
function AttachmentViewer({
  attachment,
  onClose
}: {
  attachment: Attachment
  onClose: () => void
}): React.JSX.Element {
  // 气泡已解密出 URL 时直接复用；否则按「最好可用」再解一次
  // （best = 高清原图 → 默认图 → 缩略图，命中的档位由 tier 带回来标注）
  const {
    url: decrypted,
    tier,
    degradedReason,
    busy
  } = useDecryptImage(attachment.imageMd5, 'best')
  const src = attachment.url || decrypted || ''
  // 真图还在解密：给中性提示，别先闪一张写着「图片暂时无法预览」的占位图
  const loading = !attachment.url && !decrypted && busy

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="wb-att-overlay" onClick={onClose}>
      <div className="wb-att-dialog" onClick={(e) => e.stopPropagation()}>
        {attachment.kind === 'image' ? (
          <ImagePreviewer src={src} tier={tier} degradedReason={degradedReason} loading={loading} />
        ) : attachment.kind === 'video' ? (
          <VideoPlayer videoMd5={attachment.videoMd5} />
        ) : (
          <div className="wb-att-file">
            <div className="wb-att-file-icon">📄</div>
            <div className="wb-att-file-name">{attachment.fileName || '未知文件'}</div>
            {attachment.fileSize !== undefined && (
              <div className="wb-att-file-size">
                {(attachment.fileSize / 1024 / 1024).toFixed(2)} MB
              </div>
            )}
            <div className="wb-att-file-hint">文件打开与导出需媒体解密支持（待接入）</div>
          </div>
        )}
        <button type="button" className="ui-btn wb-att-close" onClick={onClose}>
          关闭
        </button>
      </div>
    </div>
  )
}

export default AttachmentViewer
