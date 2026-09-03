import { useEffect, useRef, useState } from 'react'
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

/** 图片占位/降级图（仅查看大图时兜底；列表气泡不加载外网占位图，避免并发外链） */
export const PLACEHOLDER_IMAGE_URL = `https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=${encodeURIComponent(
  '商务聊天中发送的产品图片'
)}&image_size=portrait_4_3`

/**
 * 解密请求缓存 + 进行中去重：同一 (wxid, md5, kind) 只发一次 IPC，
 * 已成功/失败的结果直接复用，避免列表重复气泡与反复切会话造成主进程重复扫描解密。
 * 缓存值为 string（ct-media URL）或 null（已尝试但失败/无此资源）。
 */
const decryptUrlCache = new Map<string, string | null>()
const decryptPending = new Map<string, Promise<string | null>>()

function decryptKey(wxid: string, imageMd5: string, kind: 'thumb' | 'orig' | 'hd'): string {
  return `${wxid}::${imageMd5}::${kind}`
}

function requestDecryptImage(
  wxid: string,
  imageMd5: string,
  kind: 'thumb' | 'orig' | 'hd'
): Promise<string | null> {
  const key = decryptKey(wxid, imageMd5, kind)
  if (decryptUrlCache.has(key)) return Promise.resolve(decryptUrlCache.get(key) ?? null)
  let p = decryptPending.get(key)
  if (!p) {
    const media = window.api?.cs?.media
    p = (media?.decryptImage({ wxid, imageMd5, kind }) ?? Promise.resolve({ ok: false as const }))
      .then((res) => {
        const u = res.ok && res.url ? res.url : null
        decryptUrlCache.set(key, u)
        return u
      })
      .catch(() => {
        decryptUrlCache.set(key, null)
        return null
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
 */
export function useDecryptImage(
  imageMd5?: string,
  kind: 'thumb' | 'orig' | 'hd' = 'orig'
): { url: string | null; busy: boolean } {
  const wxid = useWorkbenchStore((s) => s.wxid)
  const source = useWorkbenchStore((s) => s.source)
  const [url, setUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    setUrl(null)
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
    // 已缓存（含已失败 null）：同步取，不重复发 IPC
    if (decryptUrlCache.has(key)) {
      setUrl(decryptUrlCache.get(key) ?? null)
      setBusy(false)
      return () => {
        alive = false
      }
    }
    setBusy(true)
    void requestDecryptImage(wxid, imageMd5, kind).then((u) => {
      if (alive) {
        setUrl(u)
        setBusy(false)
      }
    })
    return () => {
      alive = false
    }
  }, [imageMd5, wxid, source, kind])

  return { url, busy }
}

/**
 * 视频消息解密 hook：调 cs:media:decryptVideo 解密出可播放的 ct-media:// URL（缓存/去重同上）。
 */
export function useDecryptVideo(videoMd5?: string): { url: string | null; busy: boolean } {
  const wxid = useWorkbenchStore((s) => s.wxid)
  const source = useWorkbenchStore((s) => s.source)
  const [url, setUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
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
  // 气泡已解密出 URL 时直接复用；否则按原图再解一次（无 imageMd5 / mock 时不请求）
  const { url: decrypted } = useDecryptImage(attachment.imageMd5, 'orig')
  const src = attachment.url || decrypted || PLACEHOLDER_IMAGE_URL

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
          <img className="wb-att-image" src={src} alt="图片预览" />
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
        <button className="wb-att-close" onClick={onClose}>
          关闭
        </button>
      </div>
    </div>
  )
}

export default AttachmentViewer
