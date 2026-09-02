import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { toast } from '../../stores/toast'

/**
 * 消息右键菜单（参考 CipherTalk ContextMenuPortal 模式，自研精简版）：
 * Portal 到 body、按视口剩余空间四向翻转、透明遮罩关闭、Esc 关闭。
 */

export interface ContextMenuState {
  x: number
  y: number
  text: string
}

const MENU_W = 120
const MENU_H = 44

function MessageContextMenu({
  state,
  onClose
}: {
  state: ContextMenuState
  onClose: () => void
}): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: state.x, top: state.y })

  // 视口边界翻转：右侧不够就向左展开，下方不够就向上展开
  useLayoutEffect(() => {
    const w = menuRef.current?.offsetWidth ?? MENU_W
    const h = menuRef.current?.offsetHeight ?? MENU_H
    const left = state.x + w > window.innerWidth - 8 ? Math.max(8, state.x - w) : state.x
    const top = state.y + h > window.innerHeight - 8 ? Math.max(8, state.y - h) : state.y
    setPos({ left, top })
  }, [state])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(state.text)
      toast.success('已复制')
    } catch {
      toast.error('复制失败')
    }
    onClose()
  }

  return createPortal(
    <div
      className="ctx-mask"
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault()
        onClose()
      }}
    >
      <div
        ref={menuRef}
        className="ctx-menu"
        style={{ left: pos.left, top: pos.top }}
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className="ctx-item" onClick={() => void copy()}>
          复制
        </button>
      </div>
    </div>,
    document.body
  )
}

export default MessageContextMenu
