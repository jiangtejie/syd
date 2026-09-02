import { useEffect, useState } from 'react'
import { useWorkbenchStore } from '../../stores/workbench'

export interface Attachment {
  kind: 'image' | 'file'
  url?: string
  /** 图片消息的 md5（解密层可用时经 cs:media:decryptImage 获取真实图） */
  imageMd5?: string
  fileName?: string
  fileSize?: number
}

/** 图片占位/降级图（解密层未接入或解密失败时展示） */
export const PLACEHOLDER_IMAGE_URL = `https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=${encodeURIComponent(
  '商务聊天中发送的产品图片'
)}&image_size=portrait_4_3`

/**
 * 图片消息解密 hook：真实微信数据（source=wx）且带 imageMd5 时，
 * 调用 cs:media:decryptImage 拉取真实图 URL；mock / 无 md5 时保持 null（走占位图）。
 */
export function useDecryptImage(
  imageMd5?: string,
  kind: 'thumb' | 'orig' = 'orig'
): { url: string | null; busy: boolean } {
  const wxid = useWorkbenchStore((s) => s.wxid)
  const source = useWorkbenchStore((s) => s.source)
  const [url, setUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    setUrl(null)
    const media = window.api?.cs?.media
    if (!imageMd5 || !media || source !== 'wx' || !wxid) return
    setBusy(true)
    media
      .decryptImage({ wxid, imageMd5, kind })
      .then((res) => {
        if (!alive) return
        if (res.ok && res.url) setUrl(res.url)
        setBusy(false)
      })
      .catch(() => {
        if (alive) setBusy(false)
      })
    return () => {
      alive = false
    }
  }, [imageMd5, wxid, source, kind])

  return { url, busy }
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
