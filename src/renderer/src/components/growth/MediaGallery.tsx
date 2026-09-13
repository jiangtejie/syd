import { useEffect, useState } from 'react'
import { toast } from '../../stores/toast'
import { growthApi } from './meta'
import type { GrowthAsset } from '../../../../shared/growth'

/** 详情封面预览(本地已下载媒体, 经 ct-growth:// 协议加载; 失败自动隐藏) */

export interface LightboxProps {
  imgs: GrowthAsset[]
  index: number
  onClose: () => void
  onIndex: (i: number) => void
}

/** 图片灯箱: 全屏查看, ←/→ 翻页, Esc 关闭, 可复制当前图 */
export function Lightbox({
  imgs,
  index,
  onClose,
  onIndex
}: LightboxProps): React.JSX.Element | null {
  const cur = imgs[index] ?? null

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft') onIndex((index - 1 + imgs.length) % imgs.length)
      else if (e.key === 'ArrowRight') onIndex((index + 1) % imgs.length)
    }
    window.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [index, imgs.length, onClose, onIndex])

  if (!cur) return null
  const copy = async (): Promise<void> => {
    if (!growthApi) return
    const res = await growthApi.copyClipboard({ relPath: cur.relPath })
    if (!res.ok) toast.error(res.error || '复制失败')
    else toast.success('当前图已复制, 到微信粘贴即可')
  }

  return (
    <div className="gth-lightbox" onClick={onClose}>
      <img
        className="gth-lightbox-img"
        src={'ct-growth://media/' + cur.relPath}
        alt={'素材图 ' + String(index + 1)}
        onClick={(e) => e.stopPropagation()}
      />
      {imgs.length > 1 ? (
        <>
          <button
            className="gth-lightbox-nav left"
            type="button"
            aria-label="上一张"
            onClick={(e) => {
              e.stopPropagation()
              onIndex((index - 1 + imgs.length) % imgs.length)
            }}
          >
            ‹
          </button>
          <button
            className="gth-lightbox-nav right"
            type="button"
            aria-label="下一张"
            onClick={(e) => {
              e.stopPropagation()
              onIndex((index + 1) % imgs.length)
            }}
          >
            ›
          </button>
          <span className="gth-lightbox-count">
            {String(index + 1)}/{String(imgs.length)}
          </span>
        </>
      ) : null}
      <div className="gth-lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <button className="ui-btn gth-btn sm" type="button" onClick={() => void copy()}>
          复制当前图
        </button>
        <button className="ui-btn gth-btn sm" type="button" onClick={onClose}>
          关闭 (Esc)
        </button>
      </div>
    </div>
  )
}

export interface MediaGalleryProps {
  assets: GrowthAsset[]
  remoteImageUrls: string[]
  /** 远程视频直链(平台视频素材, 本地不保存视频文件) */
  remoteVideoUrl: string
}

/** 图文画廊: 大图 + 左右翻页 + 缩略图 + 复制当前图(ct-growth:// 本地媒体) */
export function MediaGallery({
  assets,
  remoteImageUrls,
  remoteVideoUrl
}: MediaGalleryProps): React.JSX.Element {
  const imgs = assets.filter((a) => (a.kind === 'cover' || a.kind === 'image') && !!a.relPath)
  const [idx, setIdx] = useState(0)
  const [failed, setFailed] = useState(false)
  const [zoom, setZoom] = useState(false)

  // 渲染期钳制: 图片数量变化时索引自动收敛(素材切换由父级 key 重挂载复位)
  const count = imgs.length
  const showIdx = count > 0 ? Math.min(idx, count - 1) : 0
  const cur = count > 0 ? imgs[showIdx] : null

  const copyCurrent = async (): Promise<void> => {
    if (!growthApi || !cur) return
    const res = await growthApi.copyClipboard({ relPath: cur.relPath })
    if (!res.ok) toast.error(res.error || '复制失败')
    else toast.success('当前图已复制, 到微信粘贴即可')
  }

  const localVideo = assets.find((a) => a.kind === 'video' && a.relPath) ?? null

  async function copyRemoteVideo(): Promise<void> {
    if (!growthApi || !remoteVideoUrl) return
    const res = await growthApi.copyClipboard({ text: remoteVideoUrl })
    if (!res.ok) toast.error(res.error || '复制失败')
    else toast.success('视频链接已复制')
  }

  if (imgs.length === 0) {
    return (
      <div>
        {localVideo ? (
          <video
            className="gth-gallery-video"
            src={'ct-growth://media/' + localVideo.relPath}
            controls
            preload="metadata"
          />
        ) : null}
        {!localVideo && remoteVideoUrl ? (
          <div className="gth-empty" style={{ padding: '18px 10px' }}>
            视频素材(本地不保存视频文件)
            <div style={{ marginTop: 8 }}>
              <button
                className="ui-btn gth-btn sm"
                type="button"
                onClick={() => void copyRemoteVideo()}
              >
                复制视频链接
              </button>
            </div>
          </div>
        ) : null}
        {!localVideo && !remoteVideoUrl ? (
          <div className="gth-empty" style={{ padding: '26px 10px' }}>
            {remoteImageUrls.length > 0
              ? '该素材的 ' +
                String(remoteImageUrls.length) +
                ' 张源图尚未下载到本地(可删除后重新入库重试下载)'
              : '暂无本地图片: 该素材没有可展示的媒体'}
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div className="gth-gallery">
      <div className="gth-gallery-stage">
        {cur && !failed ? (
          <img
            className="gth-gallery-img clickable"
            decoding="async"
            src={'ct-growth://media/' + cur.relPath}
            alt={'素材图 ' + String(showIdx + 1)}
            loading="lazy"
            title="点击放大查看"
            onClick={() => setZoom(true)}
            onError={() => setFailed(true)}
          />
        ) : (
          <div className="gth-gallery-img-empty">图片加载失败</div>
        )}
        {imgs.length > 1 ? (
          <>
            <button
              className="gth-gallery-nav left"
              type="button"
              aria-label="上一张"
              onClick={() => setIdx((v) => (v - 1 + imgs.length) % imgs.length)}
            >
              ‹
            </button>
            <button
              className="gth-gallery-nav right"
              type="button"
              aria-label="下一张"
              onClick={() => setIdx((v) => (v + 1) % imgs.length)}
            >
              ›
            </button>
            <span className="gth-gallery-count">
              {String(showIdx + 1)}/{String(count)}
            </span>
          </>
        ) : null}
      </div>
      {imgs.length > 1 ? (
        <div className="gth-gallery-thumbs">
          {imgs.map((a, i) => (
            <img
              key={a.id}
              className={'gth-gallery-thumb' + (i === showIdx ? ' is-active' : '')}
              loading={'lazy'}
              decoding={'async'}
              src={'ct-growth://media/' + a.relPath}
              alt="缩略图"
              onClick={() => {
                setIdx(i)
                setFailed(false)
              }}
            />
          ))}
        </div>
      ) : null}
      <button
        className="ui-btn gth-btn sm gth-gallery-copy"
        type="button"
        disabled={!cur}
        onClick={() => void copyCurrent()}
      >
        复制当前图到剪贴板
      </button>
      {zoom ? (
        <Lightbox
          imgs={imgs}
          index={showIdx}
          onClose={() => setZoom(false)}
          onIndex={(i) => {
            setIdx(i)
            setFailed(false)
          }}
        />
      ) : null}
    </div>
  )
}
