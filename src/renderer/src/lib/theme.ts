/**
 * 图表配色（echarts 只吃具体色值，拿不到 CSS 变量，所以在这里集中两份：浅色 / 深色）。
 *
 * 约定：能对上 assets/base.css 的 token 就对上（注释里标了对应变量），
 * 其余是图表专用的分类色 —— 改色时改这里 + base.css，**别在页面里再写死**。
 *
 * 取用方式：页面用 lib/useChartTheme.ts 的 useChartTheme()，它会在 <html data-theme> 变化时
 * 返回对应的一份 —— 这样切主题时图表会跟着重绘，不需要重启。
 */
export interface ChartColors {
  /** = --brand */
  brand: string
  /** = --danger */
  danger: string
  /** = --warn */
  warn: string
  /** = --info */
  info: string
  /** 图表专用：蓝（趋势对照，base.css 里对应 --chart-blue） */
  blue: string
  /** 图表专用：琥珀（公众号等第三类占比） */
  amber: string
  /** 图表专用：深琥珀（第四档分类色） */
  amberDeep: string
  /** 图表专用：浅品牌色（面积/柱状的下探色） */
  brandSoft: string
  /** 坐标轴与分隔线 */
  axisLabel: string
  axisLine: string
  splitLine: string
  /** 图例/正文文字 */
  legendText: string
  text: string
  /** 分类色板（饼图/多序列，顺序即优先级） */
  palette: string[]
  /** tooltip 浮层底色/描边（深色下不能是白底） */
  tooltipBg: string
  tooltipBorder: string
}

/** 浅色主题（对 Windows 浅色 UI 的旧值，视觉不变） */
export const CHART: ChartColors = {
  brand: '#07c160',
  danger: '#fa5151',
  warn: '#f5a623',
  info: '#3c82f6',
  blue: '#5b8ff9',
  amber: '#f0b429',
  amberDeep: '#f08a24',
  brandSoft: '#7fd8ad',
  axisLabel: '#8a9099',
  axisLine: '#d9dde2',
  splitLine: '#eef0f3',
  legendText: '#6b7280',
  text: '#1f2329',
  palette: ['#fa5151', '#f5a623', '#07c160', '#3c82f6', '#8e5cf0', '#00b8a9', '#c0c4cc'],
  tooltipBg: '#ffffff',
  tooltipBorder: '#e4e6eb'
}

/** 深色主题：与 base.css 的深色谱对齐（霓虹青主色 + 冷灰轴 + 半透明分隔线） */
export const CHART_DARK: ChartColors = {
  brand: '#22d3ee',
  danger: '#ff4d6d',
  warn: '#ffb020',
  info: '#5b9dff',
  blue: '#5b9dff',
  amber: '#ffb020',
  amberDeep: '#ff8a3d',
  brandSoft: 'rgba(34, 211, 238, 0.38)',
  axisLabel: '#7286a0',
  axisLine: '#1b2a3c',
  splitLine: 'rgba(120, 180, 220, 0.09)',
  legendText: '#a3b6cf',
  text: '#d7e3f4',
  palette: ['#ff4d6d', '#ffb020', '#34d399', '#22d3ee', '#a855f7', '#2dd4bf', '#64748b'],
  tooltipBg: 'rgba(8, 15, 26, 0.96)',
  tooltipBorder: 'rgba(34, 211, 238, 0.3)'
}

/** 按主题取一份（纯函数，便于以后给 EChart 之外的地方复用） */
export function chartColorsFor(dark: boolean): ChartColors {
  return dark ? CHART_DARK : CHART
}
