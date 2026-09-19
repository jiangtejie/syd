import { fmtStamp } from '../../../../shared/monitorMetrics'
import type { GrowthContentItem } from '../../../../shared/growth'

export const growthApi = window.api?.cs?.growth

/** 时间一律精确到时分秒(共享实现,别在这里再写一份) */
export const fmt = (ts: number | null | undefined): string => fmtStamp(ts)

// 注: fmtRel（相对时间，原用于订阅卡的「下次采集」）随采集链路下线删除 —— 它是那条链路上
// 唯一的消费者，留着就是一段没人调的导出。

export const fmtNum = (n: number): string => (n >= 10000 ? (n / 10000).toFixed(1) + 'w' : String(n))

export const ORIGIN_LABEL: Record<string, string> = {
  xhs: '小红书',
  douyin: '抖音',
  self: '自有',
  manual: '手工'
}

export const USAGE_LABEL: Record<string, string> = {
  ref: '内部参考',
  own: '自有素材',
  licensed: '已授权'
}

/** 详情 remoteMedia 里的远程视频直链 */
export function remoteVideoUrlOf(item: GrowthContentItem): string {
  const rm = item.extra?.['remoteMedia']
  if (rm && typeof rm === 'object') {
    const u = (rm as Record<string, unknown>)['videoUrl']
    if (typeof u === 'string') return u
  }
  return ''
}

/** 详情 remoteMedia 里的远程图源(供未下载提示/来源链接) */
export function remoteImageUrlsOf(item: GrowthContentItem): string[] {
  const rm = item.extra?.['remoteMedia']
  if (rm && typeof rm === 'object') {
    const urls = (rm as Record<string, unknown>)['imageUrls']
    if (Array.isArray(urls)) return urls.filter((u): u is string => typeof u === 'string')
  }
  return []
}
