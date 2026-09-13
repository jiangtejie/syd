/**
 * 图表配色（echarts 只吃具体色值，拿不到 CSS 变量，所以在这里集中一份）。
 *
 * 约定：能对上 `assets/base.css` 的 token 就对上（注释里标了对应变量），
 * 其余是图表专用的分类色 —— 改色时改这里 + base.css，**别在页面里再写死**。
 */
export const CHART = {
  /** = --brand（微信绿） */
  brand: '#07c160',
  /** = --danger */
  danger: '#fa5151',
  /** = --warn */
  warn: '#f5a623',
  /** = --info */
  info: '#3c82f6',
  /** 图表专用：蓝（趋势对照，base.css 里对应 --chart-blue） */
  blue: '#5b8ff9',
  /** 图表专用：琥珀（公众号等第三类占比） */
  amber: '#f0b429',
  /** 图表专用：深琥珀（第四档分类色） */
  amberDeep: '#f08a24',
  /** 图表专用：浅绿（面积/柱状的下探色） */
  brandSoft: '#7fd8ad',
  /** 坐标轴与分隔线（与 --text-3 / --border / --border-light 同族） */
  axisLabel: '#8a9099',
  axisLine: '#d9dde2',
  splitLine: '#eef0f3',
  /** 图例文字（比 --text-2 浅一档） */
  legendText: '#6b7280',
  /** 分类色板（饼图/多序列，顺序即优先级） */
  palette: ['#fa5151', '#f5a623', '#07c160', '#3c82f6', '#8e5cf0', '#00b8a9', '#c0c4cc']
} as const
