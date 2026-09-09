/**
 * 数字滚动(count-up): 指标值变化时从上一值平滑过渡到目标值。
 * - 首次挂载从 0 开始;
 * - 系统开启「减少动效」时直接给终值;
 * - 目标为 null(未加载)时原样返回。
 */

import { useEffect, useRef, useState } from 'react'

function reduceMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function useCountUp(target: number | null, duration = 620): number | null {
  const [value, setValue] = useState<number | null>(target)
  const currentRef = useRef(0)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    if (target === null || !Number.isFinite(target)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 未加载时原样回填
      setValue(target)
      return
    }
    if (reduceMotion() || duration <= 0) {
      currentRef.current = target

      setValue(target)
      return
    }
    const from = currentRef.current
    const delta = target - from
    if (delta === 0) {
      setValue(target)
      return
    }
    const start = performance.now()
    const tick = (now: number): void => {
      const p = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - p, 3)
      const v = Math.round(from + delta * eased)
      currentRef.current = v
      setValue(v)
      if (p < 1) rafRef.current = requestAnimationFrame(tick)
      else currentRef.current = target
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  }, [target, duration])

  return value
}
