import type { GrowthContentKind, GrowthInteractions } from '../../../../shared/growth'

/**
 * 第三方数据服务适配器 SPI(Phase 1 按供应商实现并 registerAdapter)。
 * 供应商示例: chanmama(抖音) / newhong(小红书) 等。
 * 合规: 只调用供应商开放 API 并遵守其条款与配额; 不做平台侧对抗抓取。
 */

export interface ThirdpartyRankQuery {
  /** 城市(可为空 = 全国) */
  city: string
  /** 业态/类目(如 火锅/烘焙/咖啡) */
  bizType: string
  /** 目标(榜单名/关键词/账号/话题, 按订阅 targetKind 语义) */
  target: string
  /** 统计窗口天数 */
  windowDays: number
}

/** 供应商返回并归一化后的素材条目(入库前形态) */
export interface ThirdpartyRankItem {
  platformItemId: string
  origin: string
  kind: GrowthContentKind
  title: string
  text?: string
  authorName?: string
  authorId?: string
  link?: string
  publishedAt?: number | null
  interactions: GrowthInteractions
}

export interface ThirdpartyAdapter {
  vendor: string
  label: string
  /** 拉取榜单/素材列表(归一化为 ThirdpartyRankItem) */
  hotRank(query: ThirdpartyRankQuery): Promise<ThirdpartyRankItem[]>
}

const registry = new Map<string, ThirdpartyAdapter>()

export function registerAdapter(adapter: ThirdpartyAdapter): void {
  registry.set(adapter.vendor, adapter)
}

export function adapterOf(vendor: string): ThirdpartyAdapter | null {
  return registry.get(vendor) ?? null
}
