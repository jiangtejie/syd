/**
 * 图片档位（微信本地的三份 .dat）与「取最好可用」的纯逻辑。
 *
 * 微信把一张图按三档落地在 `msg/attach` 下：
 * - `<md5>_t.dat` 缩略图：收到消息即落地（实测平均 4KB）
 * - `<md5>.dat`   默认图：PC 端自动下载（实测平均 44KB，群内近 14 天命中 99.3%）
 * - `<md5>_h.dat` 高清原图：在客户端点开「查看原图」才有（实测平均 181KB，同一批命中 56%）
 *
 * 为什么把这层单独拎出来：早期 `kind='orig'` 的兜底顺序是 orig → thumb → hd，
 * **缩略图排在高清前面**，而且回退成功时只回 `{ok:true,url}`、不告诉调用方命中的是哪一档 ——
 * 大图预览、飞书证据附件、上报归档都以为自己拿到的是原图（实测本机 56% 的群图磁盘上就躺着
 * 181KB 的高清，却一直被当成 44KB 的默认图用）。顺序、后缀、档位名在这里固化成纯函数，
 * 自检 `scripts/image-tier-selftest.mjs` 直接断言。
 *
 * 放在 shared：主进程（mediaService / lark / report）与渲染端（大图预览标注）必须同一套口径。
 */

/** 本地实际存在的一档 */
export type ImageTier = 'hd' | 'orig' | 'thumb'

/** 请求语义：best=最好可用（默认），其余为指定档位起步 */
export type ImageKind = 'best' | ImageTier

/** 由好到差（数组顺序即优先级，别改） */
export const IMAGE_TIERS: readonly ImageTier[] = ['hd', 'orig', 'thumb']

/**
 * 请求语义 → 尝试顺序。每个 kind 都把三档列全，任何一档缺失都能继续往下兜底：
 * - best/hd：高清 → 默认 → 缩略图（要的就是最清楚的）
 * - orig：默认 → 高清 → 缩略图（要「默认那档」，但高清比缩略图更接近原图，所以排它前面）
 * - thumb：缩略图 → 默认 → 高清（列表气泡场景，先从最省的开始）
 */
export function tierOrder(kind: ImageKind = 'best'): ImageTier[] {
  switch (kind) {
    case 'thumb':
      return ['thumb', 'orig', 'hd']
    case 'orig':
      return ['orig', 'hd', 'thumb']
    case 'hd':
      return ['hd', 'orig', 'thumb']
    default:
      return ['hd', 'orig', 'thumb']
  }
}

/** 档位 → 微信 .dat 文件名后缀 */
export function tierSuffix(tier: ImageTier): '' | '_t' | '_h' {
  return tier === 'thumb' ? '_t' : tier === 'hd' ? '_h' : ''
}

/** 档位中文口径（界面、日志、飞书附件名共用同一套说法） */
export function tierLabel(tier: ImageTier | undefined | null): string {
  return tier === 'hd' ? '高清原图' : tier === 'thumb' ? '缩略图' : '默认图'
}

/** 由好到差的序号（越小越好）；未知按最差算，用于「没有更好档位就不再重传」 */
export function tierRank(tier: ImageTier | undefined | null): number {
  const i = IMAGE_TIERS.indexOf((tier ?? '') as ImageTier)
  return i === -1 ? IMAGE_TIERS.length : i
}

/** a 是否严格好于 b（b 未知时 a 只要存在就算更好） */
export function isBetterTier(
  a: ImageTier | undefined | null,
  b: ImageTier | undefined | null
): boolean {
  if (!a) return false
  if (!b) return true
  return tierRank(a) < tierRank(b)
}

/** 归一化外部传入的 kind（IPC / 旧前端可能传未知值或空） */
export function normalizeKind(kind: unknown): ImageKind {
  return kind === 'thumb' || kind === 'orig' || kind === 'hd' ? kind : 'best'
}

/**
 * 按档位计数的归档/上报日志文案：高清 x / 默认 y / 缩略 z。
 * 全高清时不写详情（避免每轮日志噪音），有任何一张降级就写全 —— 排查「归档的图为什么糊」时
 * 一眼能看出是本机没落地高清，而不是归档链路把图压小了。
 */
export function tierTallyText(tally: Record<ImageTier, number>): string {
  const degraded = tally.orig + tally.thumb
  if (degraded === 0) return tally.hd > 0 ? '（图片全为高清原图）' : ''
  const thumbNote =
    tally.thumb > 0 ? `，${tierLabel('thumb')}${tally.thumb} 张是微信里没点开查看原图` : ''
  return `（图片档位:高清 ${tally.hd} / 默认 ${tally.orig} / 缩略 ${tally.thumb}${thumbNote}）`
}
