import { useEffect, useRef, type ReactNode } from 'react'
import './ui.css'

/**
 * 内容型弹层基元（选择 / 详情 / 表单）。
 *
 * 为什么要有它：全仓此前有四套弹层实现（业务面板两套、对话页 .wb-*、图片灯箱）
 * 各写一份遮罩 + 卡片 + 关闭按钮 —— 圆角、遮罩深浅、关闭位置都对不上。
 * 这里收敛成一套：遮罩 / 卡片 / 头（标题 + 说明 + 关闭）/ 体（可滚）/ 脚（动作）。
 *
 * 与 ConfirmDialog 的分工：是/否确认走 ConfirmDialog（它有 Promise 契约与"焦点落在取消"的策略）；
 * 本组件不管 Promise，只负责"把内容放进一个像样的弹层里"。
 *
 * 无障碍：role=dialog + aria-modal，标题用 aria-labelledby 关联；打开时焦点进面板（首个可聚焦元素），
 * 关闭后焦点还给触发它的元素；Esc 与点遮罩关闭，打开期间锁 body 滚动。
 */
export interface ModalProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  /** 标题右侧的一句话说明（单行省略） */
  desc?: ReactNode
  /** 尺寸：sm 460 / md 720 / lg 920 */
  size?: 'sm' | 'md' | 'lg'
  /** 底部动作区；不传则不渲染底栏 */
  actions?: ReactNode
  children: ReactNode
}

export function Modal({
  open,
  onClose,
  title,
  desc,
  size = 'md',
  actions,
  children
}: ModalProps): React.JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null)
  const lastFocus = useRef<Element | null>(null)

  useEffect(() => {
    if (!open) return
    lastFocus.current = document.activeElement
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    // 焦点进面板：优先第一个可聚焦控件，没有就落在面板本身（便于读屏读出标题）
    const first = panelRef.current?.querySelector<HTMLElement>(
      'input, select, textarea, button:not(.ui-modal-close)'
    )
    ;(first ?? panelRef.current)?.focus?.()
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
      const el = lastFocus.current
      if (el instanceof HTMLElement) el.focus?.()
    }
  }, [open, onClose])

  if (!open) return null
  const titleId = 'ui-modal-title'

  return (
    <div
      className={'ui-mask'}
      role={'presentation'}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className={'ui-modal' + (size === 'md' ? '' : ' is-' + size)}
        role={'dialog'}
        aria-modal={'true'}
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={panelRef}
      >
        <div className={'ui-modal-head'}>
          <span className={'t'} id={titleId}>
            {title}
          </span>
          {desc !== undefined && desc !== null && desc !== '' ? (
            <span className={'s'}>{desc}</span>
          ) : null}
          <button
            className={'ui-btn ui-modal-close'}
            type={'button'}
            onClick={onClose}
            aria-label={'关闭'}
          >
            关闭
          </button>
        </div>
        <div className={'ui-modal-body'}>{children}</div>
        {actions ? <div className={'ui-modal-foot'}>{actions}</div> : null}
      </div>
    </div>
  )
}
