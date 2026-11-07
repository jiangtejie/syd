import type { EChartsOption } from 'echarts'
import type { MonitorData } from '../../../shared/monitorMetrics'
import type { ChartColors } from '../lib/theme'

/**
 * 监控中心四张图的 ECharts 配置（纯函数：指标 + 当前主题配色 → option，便于单独调整样式与联动）。
 * 从 MonitorPage 拆出，页面只负责取数与布局。
 *
 * 配色不再写死：由页面 useChartTheme() 传入当前主题的一份（深色 / 浅色），
 * 轴、图例、tooltip、中心数字都跟着 data-theme 走；切主题时 EChart 会重建主题并重绘。
 * 轴/网格/图例/tooltip 的默认色已由 EChart 注册的 cs-light / cs-dark 主题兜底，
 * 这里只覆盖「图形颜色 + 字号 + 少量布局」，避免两处各写一份色值。
 */

/** 轴标签字号（图表内字号不参与 CSS 阶梯：canvas 渲染，按图表密度给 10/11） */
const AXIS_FONT = 10
const LEGEND_FONT = 11

/** 中心读数用的等宽字体栈（HUD 数字感，与 .ui-num 同口径） */
const MONO_FONT = 'ui-monospace, "Cascadia Code", Consolas, monospace'

/** 横向柱/趋势的通用网格：贴边、留出轴标签空间 */
const GRID = { left: 8, right: 10, top: 28, bottom: 0, containLabel: true }

export function buildTrendOption(metrics: MonitorData, c: ChartColors): EChartsOption {
  return {
    animationDuration: 420,
    tooltip: { trigger: 'axis' },
    legend: {
      data: ['新增', '解决'],
      top: 0,
      right: 0,
      icon: 'circle',
      itemWidth: 8,
      itemHeight: 8,
      itemGap: 12,
      textStyle: { fontSize: LEGEND_FONT }
    },
    grid: GRID,
    xAxis: {
      type: 'category',
      data: metrics.trend.map((t) => t.day),
      axisTick: { show: false },
      axisLabel: { fontSize: AXIS_FONT }
    },
    yAxis: { type: 'value', minInterval: 1, axisLabel: { fontSize: AXIS_FONT } },
    series: [
      {
        name: '新增',
        type: 'bar',
        data: metrics.trend.map((t) => t.created),
        itemStyle: { color: c.danger, borderRadius: [3, 3, 0, 0] },
        barMaxWidth: 14
      },
      {
        name: '解决',
        type: 'line',
        data: metrics.trend.map((t) => t.resolved),
        itemStyle: { color: c.brand },
        lineStyle: { width: 2 },
        symbol: 'circle',
        symbolSize: 5,
        smooth: false
      }
    ]
  }
}

export function buildTypeOption(metrics: MonitorData, c: ChartColors): EChartsOption {
  const total = metrics.typeOpen.reduce((n, x) => n + x.value, 0)
  return {
    animationDuration: 420,
    tooltip: { trigger: 'item', formatter: '{b}: {c}（{d}%）' },
    legend: {
      bottom: 0,
      icon: 'circle',
      itemWidth: 8,
      itemHeight: 8,
      itemGap: 12,
      textStyle: { fontSize: AXIS_FONT }
    },
    series: [
      {
        type: 'pie',
        radius: ['46%', '68%'],
        center: ['50%', '44%'],
        avoidLabelOverlap: true,
        itemStyle: { borderRadius: 4, borderColor: 'transparent', borderWidth: 2 },
        label: { show: false },
        emphasis: { scale: true, scaleSize: 4 },
        data: metrics.typeOpen.map((x, i) => ({
          name: x.name,
          value: x.value,
          itemStyle: { color: c.palette[i % c.palette.length] }
        }))
      }
    ],
    graphic: [
      {
        type: 'text',
        left: 'center',
        top: '32%',
        style: {
          text: String(total),
          fontSize: 20,
          fontWeight: 700,
          fontFamily: MONO_FONT,
          fill: c.text,
          textAlign: 'center'
        },
        z: 10
      },
      {
        type: 'text',
        left: 'center',
        top: '51%',
        style: {
          text: '待处理',
          fontSize: AXIS_FONT,
          fill: c.legendText,
          textAlign: 'center'
        },
        z: 10
      }
    ] as EChartsOption['graphic']
  }
}

export function buildGroupOption(metrics: MonitorData, c: ChartColors): EChartsOption {
  const rows = [...metrics.groupTop].reverse()
  return {
    animationDuration: 300,
    tooltip: { trigger: 'item' },
    grid: { left: 8, right: 24, top: 4, bottom: 0, containLabel: true },
    xAxis: { type: 'value', minInterval: 1, axisLabel: { fontSize: AXIS_FONT } },
    yAxis: {
      type: 'category',
      data: rows.map((g) => (g.name.length > 14 ? g.name.slice(0, 14) + '…' : g.name)),
      axisTick: { show: false },
      axisLabel: { fontSize: AXIS_FONT }
    },
    series: [
      {
        type: 'bar',
        data: rows.map((g, i) => ({
          value: g.value,
          // 最上面一条（数值最大）用主色，其余用品牌色的低饱和版本 → 一眼看出榜首
          itemStyle: {
            color: i === rows.length - 1 ? c.brand : c.brandSoft,
            borderRadius: [0, 3, 3, 0]
          }
        })),
        barMaxWidth: 12
      }
    ]
  }
}

export function buildAgeOption(metrics: MonitorData, c: ChartColors): EChartsOption {
  // 积压越久越危险：蓝 → 黄 → 橙 → 红
  const colors = [c.info, c.warn, c.amberDeep, c.danger]
  return {
    animationDuration: 300,
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 8, right: 8, top: 20, bottom: 0, containLabel: true },
    xAxis: {
      type: 'category',
      data: metrics.age.map((a) => a.label),
      axisTick: { show: false },
      axisLabel: { fontSize: AXIS_FONT }
    },
    yAxis: { type: 'value', minInterval: 1, axisLabel: { fontSize: AXIS_FONT } },
    series: [
      {
        type: 'bar',
        data: metrics.age.map((a, i) => ({
          value: a.value,
          itemStyle: { color: colors[i % colors.length], borderRadius: [3, 3, 0, 0] }
        })),
        barMaxWidth: 42,
        label: { show: true, position: 'top', fontSize: AXIS_FONT, color: c.legendText }
      }
    ]
  }
}
