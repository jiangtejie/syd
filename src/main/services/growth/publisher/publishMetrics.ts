/**
 * 发布登记的**纯逻辑**（零依赖，可离线自检）。
 *
 * 从 IPC 里拆出来的原因：这里是「用户手填数字」的唯一入口，录错一个数量级会直接污染
 * 素材分与 ROI —— 而在此之前**根本没有这个入口**（只有 AI 对话工具能登记，看板空态
 * 还指引用户去点一个不存在的按钮）。校验规则必须能脱离界面单独钉住。
 */

/** 渠道选项。**不设白名单**：历史数据与平台变化都要求宽松（写进来的未知渠道原样显示） */
export const PUBLISH_CHANNELS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'wxMoments', label: '微信朋友圈' },
  { value: 'wxGroup', label: '微信群' },
  { value: 'wxChat', label: '微信私聊' },
  { value: 'douyin', label: '抖音' },
  { value: 'xhs', label: '小红书' },
  { value: 'video', label: '视频号' },
  { value: 'other', label: '其他' }
]

export function channelLabel(value: string): string {
  const v = (value ?? '').trim()
  return PUBLISH_CHANNELS.find((c) => c.value === v)?.label ?? v ?? ''
}

/** 计数类字段上限：超过这个数量级的输入一定是录错了（多打一位/多打一个零） */
export const MAX_COUNT = 100_000_000
/** 金额上限（元） */
export const MAX_AMOUNT = 100_000_000

export interface PublishMetricsInput {
  channel: string
  likes: number
  collects: number
  comments: number
  shares: number
  follows: number
  leads: number
  amount: number
  outputId?: number | null
}

export type PublishMetricsResult =
  { ok: true; value: PublishMetricsInput } | { ok: false; error: string }

/** 只有这些字段是数值（写回 out 时不能用 keyof，否则联合类型会窄化成 never） */
type NumericKey = 'likes' | 'collects' | 'comments' | 'shares' | 'follows' | 'leads' | 'amount'

interface FieldSpec {
  key: NumericKey
  label: string
  max: number
  integer: boolean
}

const FIELDS: FieldSpec[] = [
  { key: 'likes', label: '点赞', max: MAX_COUNT, integer: true },
  { key: 'collects', label: '收藏', max: MAX_COUNT, integer: true },
  { key: 'comments', label: '评论', max: MAX_COUNT, integer: true },
  { key: 'shares', label: '转发', max: MAX_COUNT, integer: true },
  { key: 'follows', label: '新增关注', max: MAX_COUNT, integer: true },
  { key: 'leads', label: '新客线索', max: MAX_COUNT, integer: true },
  { key: 'amount', label: '成交金额', max: MAX_AMOUNT, integer: false }
]

const isBlank = (v: unknown): boolean => v === undefined || v === null || String(v).trim() === ''

export function parsePublishMetrics(input: Record<string, unknown>): PublishMetricsResult {
  const channelRaw = String(input?.channel ?? '').trim()
  if (channelRaw.length > 32) return { ok: false, error: '渠道名过长（最多 32 字）' }
  const channel = channelRaw || 'other'

  const out: PublishMetricsInput = {
    channel,
    likes: 0,
    collects: 0,
    comments: 0,
    shares: 0,
    follows: 0,
    leads: 0,
    amount: 0
  }

  for (const f of FIELDS) {
    const raw = input?.[f.key]
    if (isBlank(raw)) continue
    const n = Number(raw)
    if (!Number.isFinite(n)) return { ok: false, error: `「${f.label}」请填数字` }
    if (n < 0) return { ok: false, error: `「${f.label}」不能是负数` }
    if (n > f.max) return { ok: false, error: `「${f.label}」数值异常（超过上限 ${f.max}）` }
    out[f.key] = f.integer ? Math.round(n) : Math.round(n * 100) / 100
  }

  const anyValue =
    out.likes + out.collects + out.comments + out.shares + out.follows + out.leads + out.amount > 0
  if (!anyValue) {
    return { ok: false, error: '至少填写一项效果数据（点赞/收藏/评论/转发/关注/线索/金额）' }
  }

  const oid = Number(input?.outputId)
  if (Number.isFinite(oid) && oid > 0) out.outputId = Math.floor(oid)
  return { ok: true, value: out }
}

export interface MetricLike {
  likes: number
  collects: number
  comments: number
  shares: number
  follows: number
  leads: number
  amount: number
}

/**
 * 多轮登记的合计。
 * 注意这是「历次快照求和」而不是「取最新」——快照是**增量登记**（每次发一轮填一轮），
 * 求和对得上用户心智；界面上要写清「合计（历次登记之和）」，别让人以为是当前累计。
 */
export function metricTotals(rows: MetricLike[]): {
  count: number
  likes: number
  collects: number
  comments: number
  shares: number
  follows: number
  leads: number
  amount: number
} {
  const out = {
    count: (rows ?? []).length,
    likes: 0,
    collects: 0,
    comments: 0,
    shares: 0,
    follows: 0,
    leads: 0,
    amount: 0
  }
  for (const r of rows ?? []) {
    out.likes += Number(r?.likes ?? 0) || 0
    out.collects += Number(r?.collects ?? 0) || 0
    out.comments += Number(r?.comments ?? 0) || 0
    out.shares += Number(r?.shares ?? 0) || 0
    out.follows += Number(r?.follows ?? 0) || 0
    out.leads += Number(r?.leads ?? 0) || 0
    out.amount += Number(r?.amount ?? 0) || 0
  }
  out.amount = Math.round(out.amount * 100) / 100
  return out
}
