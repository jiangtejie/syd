/**
 * 弹层通用键盘行为: Esc 关闭。
 * 仅在 active 为 true 时挂监听, 避免多个弹层同时抢键盘。
 */

import { useEffect } from 'react'

export function useEscape(active: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!active) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [active, onClose])
}
