import { useEffect, useState } from 'react'
import { chartColorsFor, type ChartColors } from './theme'

/** 当前是否深色主题：跟着 <html data-theme> 走（applyResolved 是唯一写入点） */
function isDark(): boolean {
  return document.documentElement.dataset.theme === 'dark'
}

/**
 * 订阅外观主题。切换主题时 <html data-theme> 会被改写，
 * 这里用 MutationObserver 监听，返回当前是否深色。
 */
export function useDarkTheme(): boolean {
  const [dark, setDark] = useState(isDark)
  useEffect(() => {
    const el = document.documentElement
    const observer = new MutationObserver(() => setDark(isDark()))
    observer.observe(el, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  return dark
}

/** 图表配色：深色/浅色各一份，随主题切换自动更新（页面不用自己判断主题） */
export function useChartTheme(): ChartColors {
  return chartColorsFor(useDarkTheme())
}
