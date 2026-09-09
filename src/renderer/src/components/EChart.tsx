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

interface EChartProps {
  /** ECharts 配置（组件收到变化会整体重绘） */
  option: EChartsOption
  /** 容器高度，默认 180 */
  height?: number | string
}

/**
 * 通用 ECharts 容器：挂载时 init、option 变化 setOption(notMerge)、
 * 尺寸变化通过 ResizeObserver resize、卸载时 dispose，避免泄漏。
 */
export default function EChart({ option, height = 180 }: EChartProps): React.JSX.Element {
  const elRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)

  useEffect(() => {
    const el = elRef.current
    if (!el) return
    const chart = echarts.init(el)
    chartRef.current = chart
    const observer = new ResizeObserver(() => {
      chart.resize()
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge: true })
  }, [option])

  return <div ref={elRef} style={{ width: '100%', height }} />
}
