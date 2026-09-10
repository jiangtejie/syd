import type { EChartsOption } from 'echarts'
import type { MonitorData } from '../../../shared/monitorMetrics'

/**
 * 监控中心四张图的 ECharts 配置（纯函数：输入指标即可，便于单独调整样式与联动）。
 * 从 MonitorPage 拆出，页面只负责取数与布局。
 */
export const BRAND = '#07c160'
const PALETTE = ['#fa5151', '#f5a623', '#07c160', '#3c82f6', '#8e5cf0', '#00b8a9', '#c0c4cc']

export function buildTrendOption(metrics: MonitorData): EChartsOption {
  return {
    tooltip: { trigger: 'axis' },
    legend: { data: ['新增', '解决'], top: 0, right: 0, textStyle: { fontSize: 11 } },
    grid: { left: 8, right: 8, top: 26, bottom: 0, containLabel: true },
    xAxis: {
      type: 'category',
      data: metrics.trend.map((t) => t.day),
      axisLabel: { fontSize: 10 }
    },
    yAxis: { type: 'value', minInterval: 1, axisLabel: { fontSize: 10 } },
    series: [
      {
        name: '新增',
        type: 'bar',
        data: metrics.trend.map((t) => t.created),
        itemStyle: { color: '#fa8a8a' },
        barMaxWidth: 14
      },
      {
        name: '解决',
        type: 'line',
        data: metrics.trend.map((t) => t.resolved),
        itemStyle: { color: BRAND },
        lineStyle: { width: 2 }
      }
    ]
  }
}

export function buildTypeOption(metrics: MonitorData): EChartsOption {
  const total = metrics.typeOpen.reduce((n, x) => n + x.value, 0)
  return {
    tooltip: { trigger: 'item', formatter: '{b}: {c}（{d}%）' },
    legend: { bottom: 0, textStyle: { fontSize: 10 } },
    series: [
      {
        type: 'pie',
        radius: ['42%', '66%'],
        center: ['50%', '44%'],
        avoidLabelOverlap: true,
        itemStyle: { borderRadius: 4, borderColor: '#fff', borderWidth: 1 },
        label: { show: false },
        data: metrics.typeOpen.map((x, i) => ({
          name: x.name,
          value: x.value,
          itemStyle: { color: PALETTE[i % PALETTE.length] }
        }))
      }
    ],
    graphic: [
      {
        type: 'text',
        left: 'center',
        top: '34%',
        style: {
          text: String(total),
          fontSize: 20,
          fontWeight: 700,
          fill: '#1f2329',
          textAlign: 'center'
        },
        z: 10
      },
      {
        type: 'text',
        left: 'center',
        top: '52%',
        style: { text: '待处理', fontSize: 10, fill: '#999', textAlign: 'center' },
        z: 10
      }
    ] as EChartsOption['graphic']
  }
}

export function buildGroupOption(metrics: MonitorData): EChartsOption {
  const rows = [...metrics.groupTop].reverse()
  return {
    tooltip: { trigger: 'item' },
    grid: { left: 8, right: 30, top: 4, bottom: 0, containLabel: true },
    xAxis: { type: 'value', minInterval: 1, axisLabel: { fontSize: 10 } },
    yAxis: {
      type: 'category',
      data: rows.map((g) => (g.name.length > 14 ? g.name.slice(0, 14) + '…' : g.name)),
      axisLabel: { fontSize: 10 }
    },
    series: [
      {
        type: 'bar',
        data: rows.map((g, i) => ({
          value: g.value,
          itemStyle: { color: i === rows.length - 1 ? BRAND : '#7fd8ad' }
        })),
        barMaxWidth: 12
      }
    ]
  }
}

export function buildAgeOption(metrics: MonitorData): EChartsOption {
  const colors = ['#3c82f6', '#f5a623', '#f08a24', '#fa5151']
  return {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 8, right: 8, top: 20, bottom: 0, containLabel: true },
    xAxis: {
      type: 'category',
      data: metrics.age.map((a) => a.label),
      axisLabel: { fontSize: 10 }
    },
    yAxis: { type: 'value', minInterval: 1, axisLabel: { fontSize: 10 } },
    series: [
      {
        type: 'bar',
        data: metrics.age.map((a, i) => ({ value: a.value, itemStyle: { color: colors[i] } })),
        barMaxWidth: 34,
        label: { show: true, position: 'top', fontSize: 10 }
      }
    ]
  }
}
