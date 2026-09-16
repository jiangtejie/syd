/**
 * 大图预览的自适应几何（纯函数，自检：`scripts/image-fit-selftest.mjs`）。
 *
 * 为什么单独一层：预览的 `src` 会变（本地占位 SVG → 解密出的真图 → 更高档位的图），
 * 浏览器给的是**每一张图各自的** naturalWidth/Height。一旦把「上一张图的原图尺寸 × 缩放」
 * 写死进 style，新图就会被塞进旧图的宽高比里 —— 线上就是这样变形的：
 * 占位图 360×480 先 onLoad 定下 3:4 的盒子，随后真图（横图/长图）被强行拉成 3:4。
 * 所以「换图必须重测尺寸」「显示宽高比 = 原图宽高比」这两条在这里固化成纯函数与不变量。
 */

export interface Size {
  w: number
  h: number
}

/** 小图自动放大上限（再大就虚化了） */
export const FIT_MAX = 2.6
/** 用户手动缩放的范围 */
export const MIN_SCALE = 0.2
export const MAX_SCALE = 5

/**
 * 归一化浏览器给的 naturalWidth/Height：0/NaN/负数都不可信（图片未解码完、SVG 无固有尺寸等），
 * 按已知的一边等比补另一边，都没有就给 800×600 兜底 —— 绝不返回 0，否则后面会算出 Infinity。
 */
export function normalizeNatural(
  w: unknown,
  h: unknown,
  fallback: Size = { w: 800, h: 600 }
): Size {
  const nw = Number(w)
  const nh = Number(h)
  const okW = Number.isFinite(nw) && nw > 0
  const okH = Number.isFinite(nh) && nh > 0
  if (okW && okH) return { w: Math.round(nw), h: Math.round(nh) }
  if (okW) return { w: Math.round(nw), h: Math.round(nw * (fallback.h / fallback.w)) }
  if (okH) return { w: Math.round(nh * (fallback.w / fallback.h)), h: Math.round(nh) }
  return { w: fallback.w, h: fallback.h }
}

/**
 * 弹层里真正能放图的那块区域。数字与 overlays.css 同口径，免得「算出来的尺寸」比「盒子」大、
 * 结果每张长图都顶出一条滚动条：
 * - 宽：max-width 92vw，且弹层（.wb-att-dialog）左右各 12px 内边距 → 再留 24px 余量；
 * - 高：max-height 80vh，且弹层上下内边距 22px + 工具栏约 30px + 两道 gap 18px → 再留 120px 余量。
 */
export function previewViewport(innerW: number, innerH: number): Size {
  const w = Math.min(Number(innerW) * 0.92, Number(innerW) - 24)
  const h = Math.min(Number(innerH) * 0.8, Number(innerH) - 120)
  return {
    w: Math.max(160, Math.round(Number.isFinite(w) ? w : 160)),
    h: Math.max(160, Math.round(Number.isFinite(h) ? h : 160))
  }
}

/** 自适应缩放：大图缩到容器内，小图放大但不超过 fitMax（不像素级放大到糊） */
export function fitScale(natural: Size, viewport: Size, fitMax: number = FIT_MAX): number {
  const n = normalizeNatural(natural.w, natural.h)
  const vw = Math.max(1, Number(viewport?.w) || 0)
  const vh = Math.max(1, Number(viewport?.h) || 0)
  const s = Math.min(vw / n.w, vh / n.h)
  if (!Number.isFinite(s) || s <= 0) return 1
  return Math.min(s, fitMax)
}

/** 夹住**用户手动**缩放（自适应缩放不走这里：超大图可能确实需要 <MIN_SCALE 才放得下） */
export function clampScale(scale: number): number {
  const s = Number(scale)
  if (!Number.isFinite(s)) return 1
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))
}

/**
 * 显示尺寸：**宽高同乘一个系数** → 宽高比恒定。预览变形的根因就是这条被破坏
 * （拿上一张图的尺寸配这一张图的缩放）。
 *
 * 刻意**不做整数取整**：取整在小图上会把比例算歪（120×90 缩到 0.05 → 6×4.5，取整成 6×5 就是 1.2:1 了）。
 * 小数 px 交给浏览器布局，比例严格等于原图。
 */
export function displaySize(natural: Size, scale: number): Size {
  const n = normalizeNatural(natural.w, natural.h)
  const s = Number(scale)
  const use = Number.isFinite(s) && s > 0 ? s : 1
  return { w: Math.max(0.01, n.w * use), h: Math.max(0.01, n.h * use) }
}

/**
 * 显示尺寸是否保持原图宽高比 —— 自检与运行时断言共用同一判据。
 * 相对误差在 tolerance 内即通过；另外放行「宽高各自只差不到 1px」的情况：
 * 极小尺寸（<10px）下这是取整的物理极限，不是形变。
 */
export function keepsAspectRatio(natural: Size, shown: Size, tolerance = 0.01): boolean {
  const a = natural.w / natural.h
  const b = shown.w / shown.h
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return false
  if (Math.abs(a - b) / a <= tolerance) return true
  return Math.abs(shown.w / a - shown.h) < 1 || Math.abs(shown.h * a - shown.w) < 1
}
