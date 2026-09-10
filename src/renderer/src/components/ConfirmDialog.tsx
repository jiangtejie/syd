import { useEffect, useRef } from 'react'

export interface ConfirmOptions {
  title: string
  message?: string
  confirmText?: string
  cancelText?: string
  /** 危险操作（如删除/清空）：确认按钮走红系 */
  danger?: boolean
}

interface Props {
  options: ConfirmOptions | null
  /** 用户的选择：true=确认，false=取消/关闭（弹窗的关闭与 Promise 结算都由宿主统一处理） */
  onResolve: (ok: boolean) => void
}

/**
 * 统一确认弹窗：替代 window.confirm。
 * 原生 confirm 与浅色主题割裂且无法定制；这里走自绘遮罩 + 主题 token。
 * 打开时焦点落在「取消」，避免回车误触发危险操作；Esc 关闭。
 *
 * 契约：本组件只回传一次用户选择，不做任何关闭动作 —— 宿主 onResolve 负责 close()。
 * 历史坑（务必别改回去）：旧实现确认按钮先调 onClose() 再调 onConfirm()，而 onClose 会把
 * Promise 以 false 结掉并清空 options，随后的 onConfirm 变成空操作 —— 于是「确认」永远等于
 * 「取消」，表现为「排除监控 / 合并重复 / 清空重析」这类按钮点了没反应。
 */
function ConfirmDialog({ options, onResolve }: Props): React.JSX.Element | null {
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!options) return
    cancelRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onResolve(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [options, onResolve])

  if (!options) return null
  const { title, message, confirmText = '确定', cancelText = '取消', danger = false } = options

  return (
    <div
      className="confirm-mask"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onResolve(false)
      }}
    >
      <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-label={title}>
        <div className="confirm-title">{title}</div>
        {message && <div className="confirm-msg">{message}</div>}
        <div className="confirm-actions">
          <button
            ref={cancelRef}
            type="button"
            className="confirm-btn"
            onClick={() => onResolve(false)}
          >
            {cancelText}
          </button>
          <button
            type="button"
            className={`confirm-btn confirm-primary${danger ? ' is-danger' : ''}`}
            onClick={() => onResolve(true)}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}

export default ConfirmDialog
