/**
 * 营销增长(growth)域共享类型 —— 主进程 / preload / 渲染端 IPC 契约。
 * 素材入库(粘贴链接 / 本地导入) / AI 拆解与爆改 / 发布包导出 / 效果回填 / 舆情。
 * 注：「第三方采集订阅 + 调度」链路已整体下线，相关类型一并删除。
 */

export type GrowthContentKind = 'image_text' | 'video' | 'unknown'
export type GrowthContentUsage = 'ref' | 'own' | 'licensed'
export type GrowthContentStatus = 'new' | 'ready' | 'used' | 'archived'

export interface GrowthInteractions {
  likes: number
  collects: number
  comments: number
  shares: number
}

/** 素材条目(仓库行) */
export interface GrowthContentItem {
  id: number
  kind: GrowthContentKind
  /** 平台标识: xhs / douyin / self / manual */
  origin: string
  platformItemId: string
  storeId: number | null
  title: string
  text: string
  authorName: string
  authorId: string
  link: string
  publishedAt: number | null
  tags: string[]
  usage: GrowthContentUsage
  interactions: GrowthInteractions
  /** 解析附加信息(remoteMedia 等), 来自 growth_content.extra_json */
  extra: Record<string, unknown>
  score: number
  status: GrowthContentStatus
  note: string
  createdAt: number
  updatedAt: number
}

export interface GrowthAsset {
  id: number
  contentId: number
  kind: 'cover' | 'image' | 'video' | 'audio' | 'other'
  sha256: string
  mime: string
  size: number
  width: number
  height: number
  durationMs: number
  relPath: string
  thumbRelPath: string
  /** 来源与授权标记,如 ref:xhs / own / licensed:<备注> */
  sourceMark: string
  createdAt: number
}

export interface GrowthDecompSummary {
  contentId: number
  modelVer: string
  /** 结构拆解(钩子/骨架等, Phase 1 填充) */
  structure: Record<string, unknown> | null
  visual: Record<string, unknown> | null
  commentTopics: string[]
  createdAt: number
}

export interface GrowthContentDetail extends GrowthContentItem {
  assets: GrowthAsset[]
  decomp: GrowthDecompSummary | null
}

export interface GrowthContentFilter {
  keyword?: string
  origin?: string
  usage?: string
  /** 状态筛选: new/ready/used/archived */
  status?: string
  /** 仅看尚未 AI 拆解的素材 */
  noDecomp?: boolean
  /** 排序: created(默认)/score/likes */
  sort?: 'created' | 'score' | 'likes'
  limit?: number
  offset?: number
}

export interface GrowthListResult {
  items: GrowthContentItem[]
  total: number
}

/** 素材仓库的规模统计（采集订阅相关字段随该链路下线删除，见 ARCHITECTURE §9） */
export interface GrowthStats {
  contentCount: number
  assetCount: number
}

// ── AI 拆解 / 爆改 / 发布回填(落地批 A/B) ──

// 注: 原有一键爆改的 GrowthRemixStyle 已随该链路删除(改由 AI 工作台工具承接)；

/** 一次爆改产出的一个输出块(titles 用换行分隔多标题; copy 为单篇正文) */
export interface GrowthRemixOutputView {
  id: number
  contentId: number
  variant: string
  title: string
  copy: string
  complianceHints: string[]
  status: string
  createdAt: number
}

/** 发布回填快照(growth_metric_snapshot) */
export interface GrowthMetricView {
  id: number
  channel: string
  /** 归因: 本次发布采用的爆改产出(可空) */
  outputId: number | null
  likes: number
  collects: number
  comments: number
  shares: number
  follows: number
  leads: number
  amount: number
  capturedAt: number
}

/** 发布登记输入(渠道/链接/互动回填) */
export interface GrowthPublishInput {
  channel: string
  /** 采用哪一版爆改产出(归因用, 可空) */
  outputId?: number | null
  url?: string
  likes?: number
  collects?: number
  comments?: number
  shares?: number
  follows?: number
  leads?: number
  amount?: number
}

/** 素材详情(含拆解/爆改产出/回填快照, getContent 返回) */
export interface GrowthContentDetailView extends GrowthContentDetail {
  remixOutputs: GrowthRemixOutputView[]
  metrics: GrowthMetricView[]
}

// ── 营销概览(看板/统计) ──

export interface GrowthOverview {
  contentCount: number
  /** 已 AI 拆解数量 */
  decompCount: number
  /** 已爆改产出数量 */
  remixOutputCount: number
  /** 有发布登记记录的素材数 */
  publishedContentCount: number
  /** 回填累计新客线索 */
  totalLeads: number
  /** 回填累计金额(元) */
  totalAmount: number
  /** 最近发布登记 */
  recentMetrics: Array<GrowthMetricView & { contentTitle: string }>
}

// ── 舆情监控(buzz) ──

export type GrowthBuzzSentiment = 'positive' | 'neutral' | 'negative' | ''
export type GrowthBuzzRisk = 'high' | 'medium' | 'low' | ''
export type GrowthBuzzStatus = 'new' | 'reviewing' | 'replied' | 'ignored'

export interface GrowthBuzzReason {
  tag: string
  weight: number
  evidence: string
}

export interface GrowthBuzzCommentView {
  id: number
  mentionId: number
  authorName: string
  content: string
  likes: number
  isHigh: boolean
  source: string
  publishedAt: number | null
  createdAt: number
}

export interface GrowthBuzzMentionView {
  id: number
  storeId: number | null
  storeName: string
  platform: string
  kind: string
  /** 原帖链接(可点击回看) */
  url: string
  platformItemId: string
  title: string
  contentText: string
  authorName: string
  authorId: string
  publishedAt: number | null
  interactions: GrowthInteractions
  /** 本地封面缩略图(ct-growth 相对路径) */
  assets: string[]
  source: string
  status: GrowthBuzzStatus
  sentiment: GrowthBuzzSentiment
  /** -100(极端负面) .. 100(极度正面) */
  score: number
  riskLevel: GrowthBuzzRisk
  reasons: GrowthBuzzReason[]
  diagnosis: Record<string, unknown>
  diagnosedAt: number | null
  note: string
  createdAt: number
  updatedAt: number
  commentCount: number
  highCommentCount: number
}

export interface GrowthBuzzOverview {
  total: number
  positive: number
  neutral: number
  negative: number
  pending: number
  highRisk: number
  avgScore: number
  recent: Array<{
    id: number
    title: string
    sentiment: string
    score: number
    platform: string
    createdAt: number
  }>
}

export interface GrowthBuzzDiagnosisView {
  source: 'rule' | 'rule+model'
  ruleScore: number
  modelScore: number | null
  finalScore: number
  sentiment: string
  riskLevel: string
  severity: string
  summary: string
  rootCauses: string[]
  suggestions: string[]
  spreadRisk: string
  reasons: GrowthBuzzReason[]
  redlineTags: string[]
  commentCount: number
  highCommentCount: number
  evidence: Array<{ author: string; content: string; likes: number; isHigh: boolean }>
  diagnosedAt: number
}

export interface GrowthBuzzAddResult {
  ok: boolean
  id?: number
  existed?: boolean
  mention?: GrowthBuzzMentionView
  diagnosis?: GrowthBuzzDiagnosisView
  diagnosisError?: string
  error?: string
}

export interface GrowthBuzzCommentsResult {
  ok: boolean
  added?: number
  skipped?: number
  total?: number
  diagnosis?: GrowthBuzzDiagnosisView
  diagnosisError?: string
  error?: string
}

export interface GrowthBuzzFilter {
  storeId?: number | null
  platform?: string
  sentiment?: string
  status?: string
  keyword?: string
  limit?: number
  offset?: number
}

export interface GrowthBuzzDetailView {
  mention: GrowthBuzzMentionView
  comments: GrowthBuzzCommentView[]
}
