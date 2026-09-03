import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { toast } from '../../stores/toast'
import { useWorkbenchStore } from '../../stores/workbench'

/**
 * 消息右键菜单：
 * - 复制消息文本；
 * - 群聊接收消息可标记/取消「团队客服」（全局标识，帮助分析与 LLM 理解会话角色）。
 * Portal 到 body、按视口剩余空间四向翻转、透明遮罩关闭、Esc 关闭。
 */

export interface ContextMenuState {
  x: number
  y: number
  text: string
  /** 群聊接收消息的发送人 username（用于团队标记） */
  senderUsername?: string
  /** 该发送人当前是否已标记为团队客服 */
  senderIsTeam?: boolean
}

const MENU_W = 170

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
    const h = menuRef.current?.offsetHeight ?? 44
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

  /** 标记/取消团队客服（store 内完成 IPC + 本地即时打标 + toast） */
  const toggleTeam = async (): Promise<void> => {
    const username = state.senderUsername
    if (!username) return
    const store = useWorkbenchStore.getState()
    if (!store.wxid) {
      toast.error('未连接微信账号')
      onClose()
      return
    }
    await store.setMsgSenderTeam(username, !state.senderIsTeam)
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
        {state.senderUsername && (
          <button type="button" className="ctx-item" onClick={() => void toggleTeam()}>
            {state.senderIsTeam ? '取消团队客服标记' : '标记为团队客服'}
          </button>
        )}
      </div>
    </div>,
    document.body
  )
}

export default MessageContextMenu
