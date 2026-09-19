import { useEffect, useState, type ReactNode } from 'react'
import { toast } from '../../stores/toast'
import { confirmAsk } from '../../stores/confirmDialog'
import { growthApi } from './meta'
import type { GrowthAsset } from '../../../../shared/growth'
import { isSelfOwned, sourceLabel } from '../../../../shared/imageSource'

/** 详情封面预览(本地已下载媒体, 经 ct-growth:// 协议加载; 失败自动隐藏) */

/**
 * 灯箱里的一张图。
 * 只要 relPath 就能显示 —— 这样素材图（GrowthAsset）与 AI 产出的候选图都能直接用同一个灯箱。
 */
export interface LightboxItem {
  relPath: string
  /** 角标（如「封面」「图2」），可空 */
  badge?: string
  /** 说明（来源/策略/模板），可空 */
  note?: string
}

export interface LightboxProps {
  items: LightboxItem[]
  index: number
  onClose: () => void
  onIndex: (i: number) => void
  /** 页面自己的动作按钮（放在底部条左侧），如「采用这张」 */
  actions?: ReactNode
  /** 是否显示「复制当前图」（默认显示） */
  allowCopy?: boolean
}

/** 图片灯箱: 全屏查看, ←/→ 翻页, Esc 关闭, 可复制当前图 */
export function Lightbox({
  items,
  index,
  onClose,
  onIndex,
  actions,
  allowCopy = true
}: LightboxProps): React.JSX.Element | null {
  const cur = items[index] ?? null

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft') onIndex((index - 1 + items.length) % items.length)
      else if (e.key === 'ArrowRight') onIndex((index + 1) % items.length)
    }
    window.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [index, items.length, onClose, onIndex])

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
        alt={(cur.badge ? cur.badge + ' ' : '') + '图 ' + String(index + 1)}
        onClick={(e) => e.stopPropagation()}
      />
      {/* 角标与说明放左上角：不遮住图片主体 */}
      {cur.badge || cur.note ? (
        <div className="gth-lightbox-info" onClick={(e) => e.stopPropagation()}>
          {cur.badge ? <span className="gth-lightbox-badge">{cur.badge}</span> : null}
          {cur.note ? <span className="gth-lightbox-note">{cur.note}</span> : null}
        </div>
      ) : null}
      {items.length > 1 ? (
        <>
          <button
            className="gth-lightbox-nav left"
            type="button"
            aria-label="上一张"
            onClick={(e) => {
              e.stopPropagation()
              onIndex((index - 1 + items.length) % items.length)
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
              onIndex((index + 1) % items.length)
            }}
          >
            ›
          </button>
          <span className="gth-lightbox-count">
            {String(index + 1)}/{String(items.length)}
          </span>
        </>
      ) : null}
      <div className="gth-lightbox-bar" onClick={(e) => e.stopPropagation()}>
        {actions}
        {allowCopy ? (
          <button className="ui-btn gth-btn sm" type="button" onClick={() => void copy()}>
            复制当前图
          </button>
        ) : null}
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
  /** 删除某张图后通知父级重拉详情（列表封面/张数都要跟着变） */
  onChanged?: () => void
}

/** 图文画廊: 大图 + 左右翻页 + 缩略图 + 复制当前图(ct-growth:// 本地媒体) */
export function MediaGallery({
  assets,
  remoteImageUrls,
  remoteVideoUrl,
  onChanged
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

  /** 删掉当前这张（误下载的、误生成的、同行的参考图都可以删）：至少保留一张，且挂在产出上的删不掉 */
  const removeCurrent = async (): Promise<void> => {
    if (!growthApi?.removeAsset || !cur) return
    const ok = await confirmAsk({
      title: '删除这张图？',
      message:
        '仅从这条素材里移除（本地文件按内容去重，可能仍被其它素材共用，所以不删文件）。' +
        (count <= 1 ? '这是最后一张图，删不掉。' : ''),
      confirmText: '删除',
      danger: true
    })
    if (!ok) return
    const res = await growthApi.removeAsset(cur.id)
    if (!res.ok) {
      toast.error(res.error || '删除失败')
      return
    }
    toast.success('已删除这张图')
    setFailed(false)
    setIdx(0)
    onChanged?.()
  }

  /**
   * 这张图是谁的：素材库里混着「同行的爆款原图」与「本店自己的图」，而界面此前只写「N 张」——
   * 实测就出过「把我们的标题压在同行原图上」的封面（用户看到的反应是「图片不对劲」）。
   * 判定口径与主进程同一份（shared/imageSource），不允许各写一套。
   */
  const srcLabel = (a: GrowthAsset): string =>
    isSelfOwned(a.sourceMark) ? sourceLabel(a.sourceMark) : '同行原图 · 只可作结构参考'

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
        {/* 来源角标：一眼看出这张是自家的还是同行的（同行原图不能当底图/成品图） */}
        {cur ? (
          <span
            className={'gth-gallery-src' + (isSelfOwned(cur.sourceMark) ? ' is-self' : '')}
            title={sourceLabel(cur.sourceMark)}
          >
            {srcLabel(cur)}
          </span>
        ) : null}
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
              alt={'缩略图 · ' + srcLabel(a)}
              title={srcLabel(a)}
              onClick={() => {
                setIdx(i)
                setFailed(false)
              }}
            />
          ))}
        </div>
      ) : null}
      <div className="gth-gallery-ops">
        <button
          className="ui-btn is-danger gth-btn sm"
          type="button"
          disabled={!cur || count <= 1}
          title={count <= 1 ? '至少要保留一张图' : '从这条素材里删掉当前这张'}
          onClick={() => void removeCurrent()}
        >
          删除这张
        </button>
        <button
          className="ui-btn gth-btn sm gth-gallery-copy"
          type="button"
          disabled={!cur}
          onClick={() => void copyCurrent()}
        >
          复制当前图到剪贴板
        </button>
      </div>
      {zoom ? (
        <Lightbox
          items={imgs.map((a) => ({ relPath: a.relPath, note: srcLabel(a) }))}
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
