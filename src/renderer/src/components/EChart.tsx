import { useEffect, useRef } from 'react'
import * as echarts from 'echarts/core'
import { BarChart, LineChart, PieChart } from 'echarts/charts'
import {
  GraphicComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsOption } from 'echarts'
import { CHART, CHART_DARK, type ChartColors } from '../lib/theme'
import { useDarkTheme } from '../lib/useChartTheme'

/**
 * 按需注册(而非 import * from 'echarts' 全量桶):
 * 全量包 1.1MB,本项目只用 柱/折线/饼 + 网格/图例/提示/图形 四类组件。
 */
echarts.use([
  BarChart,
  LineChart,
  PieChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  GraphicComponent,
  CanvasRenderer
])

/** 轴基线的主题化：深色下轴线/分隔线必须是冷灰半透明，否则白线会割裂整块深底 */
function axisTheme(c: ChartColors): Record<string, unknown> {
  return {
    axisLine: { show: true, lineStyle: { color: c.axisLine } },
    axisTick: { lineStyle: { color: c.axisLine } },
    axisLabel: { color: c.axisLabel },
    splitLine: { lineStyle: { color: c.splitLine, type: 'dashed' } },
    splitArea: { show: false }
  }
}

/** 注册两套图表主题：页面只写数据与图形，配色/轴/图例/tooltip 的默认值由这里兜住 */
function buildTheme(c: ChartColors): Record<string, unknown> {
  const axis = axisTheme(c)
  return {
    color: [...c.palette],
    backgroundColor: 'transparent',
    textStyle: { color: c.text },
    title: { textStyle: { color: c.text } },
    legend: { textStyle: { color: c.legendText } },
    tooltip: {
      backgroundColor: c.tooltipBg,
      borderColor: c.tooltipBorder,
      borderWidth: 1,
      padding: [7, 10],
      textStyle: { color: c.text, fontSize: 12 },
      extraCssText:
        'border-radius:8px;backdrop-filter:blur(6px);box-shadow:0 10px 30px rgba(0,0,0,.45);'
    },
    categoryAxis: axis,
    valueAxis: axis,
    timeAxis: axis,
    logAxis: axis
  }
}

echarts.registerTheme('cs-light', buildTheme(CHART))
echarts.registerTheme('cs-dark', buildTheme(CHART_DARK))

interface EChartProps {
  /** ECharts 配置（组件收到变化会整体重绘） */
  option: EChartsOption
  /** 容器高度，默认 180 */
  height?: number | string
}

/**
 * 通用 ECharts 容器：挂载时 init、option 变化 setOption(notMerge)、
 * 尺寸变化通过 ResizeObserver resize、卸载时 dispose，避免泄漏。
 * 主题：跟随 <html data-theme> 用 cs-light / cs-dark 两套注册主题；切主题时重建实例并回填当前 option。
 */
export default function EChart({ option, height = 180 }: EChartProps): React.JSX.Element {
  const elRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)
  const optionRef = useRef(option)
  const dark = useDarkTheme()

  // 把最新 option 同步进 ref（在 effect 里写，避免渲染期改 ref）
  useEffect(() => {
    optionRef.current = option
  }, [option])

  useEffect(() => {
    const el = elRef.current
    if (!el) return
    const chart = echarts.init(el, dark ? 'cs-dark' : 'cs-light')
    chartRef.current = chart
    chart.setOption(optionRef.current, { notMerge: true })
    const observer = new ResizeObserver(() => {
      chart.resize()
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      chart.dispose()
      chartRef.current = null
    }
  }, [dark])

  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge: true })
  }, [option])

  return <div ref={elRef} style={{ width: '100%', height }} />
}
