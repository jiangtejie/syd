/**
 * 定高列表的窗口化计算（**纯函数，零依赖**，可离线自检）。
 *
 * 为什么要有它：导出页的会话列表可能上千行（每个群/每个人一行），整表渲染时
 * 每次勾选都会重建全部 DOM。窗口化后只渲染视口内 + 上下各几行。
 * 不引第三方库（react-window 之类）：这里只需要「定高 + 垂直滚动」这一种情况，
 * 自己算清楚反而更可控，而且能像这样被离线断言。
 *
 * 约定：行高必须**固定**（调用方在 CSS 里钉死），否则窗口位置会漂。
 */

export interface VirtualWindow {
  /** 渲染切片的起止下标（左闭右开） */
  start: number
  end: number
  /** 切片上方/下方的占位高度（保持滚动条长度正确） */
  padTop: number
  padBottom: number
}

export interface VirtualWindowInput {
  scrollTop: unknown
  viewportH: unknown
  rowH: unknown
  total: unknown
  /** 视口上下各多渲染几行（滚动时不闪白） */
  overscan?: unknown
}

function num(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

export function virtualWindow(input: VirtualWindowInput): VirtualWindow {
  const rowH = Math.max(1, num(input.rowH, 1))
  const total = Math.max(0, Math.floor(num(input.total, 0)))
  if (total === 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 }

  const contentH = total * rowH
  const viewportH = Math.max(1, num(input.viewportH, 0))
  const overscan = Math.max(0, Math.floor(num(input.overscan, 4)))
  // 滚动位置夹在内容范围内：内容比视口短时内容不会滚动
  const maxScroll = Math.max(0, contentH - viewportH)
  const scrollTop = Math.min(Math.max(0, num(input.scrollTop, 0)), maxScroll)

  const firstVisible = Math.floor(scrollTop / rowH)
  const lastVisible = Math.ceil((scrollTop + viewportH) / rowH)
  const start = Math.max(0, firstVisible - overscan)
  const end = Math.min(total, lastVisible + overscan)

  return {
    start,
    end,
    padTop: start * rowH,
    padBottom: Math.max(0, (total - end) * rowH)
  }
}
