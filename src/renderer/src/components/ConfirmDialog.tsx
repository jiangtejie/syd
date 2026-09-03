import { useEffect, useRef } from 'react'

export interface ConfirmOptions {
  title: string
  message?: string
  confirmText?: string
  cancelText?: string
  /** 危险操作（如删除/清空）：确认按钮走红系 */
  danger?: boolean
  onConfirm: () => void
}

interface Props {
  options: ConfirmOptions | null
  onClose: () => void
}

/**
 * 统一确认弹窗：替代 window.confirm。
 * 原生 confirm 与浅色主题割裂且无法定制；这里走自绘遮罩 + 主题 token。
 * 打开时焦点落在「取消」，避免回车误触发危险操作；Esc 关闭。
 */
function ConfirmDialog({ options, onClose }: Props): React.JSX.Element | null {
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!options) return
    cancelRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [options, onClose])

  if (!options) return null
  const {
    title,
    message,
    confirmText = '确定',
    cancelText = '取消',
    danger = false,
    onConfirm
  } = options

  const run = (): void => {
    onClose()
    onConfirm()
  }

  return (
    <div
      className="confirm-mask"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-label={title}>
        <div className="confirm-title">{title}</div>
        {message && <div className="confirm-msg">{message}</div>}
        <div className="confirm-actions">
          <button ref={cancelRef} type="button" className="confirm-btn" onClick={onClose}>
            {cancelText}
          </button>
          <button
            type="button"
            className={`confirm-btn confirm-primary${danger ? ' is-danger' : ''}`}
            onClick={run}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}

export default ConfirmDialog
