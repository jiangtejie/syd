import { useEffect, useState } from 'react'
export interface SwitchProps {
  checked: boolean
  onChange: (v: boolean) => void
  label?: string
  disabled?: boolean
  title?: string
}

/** 样式化开关(checkbox 视觉层) */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  title
}: SwitchProps): React.JSX.Element {
  return (
    <label className={'gth-switch' + (disabled ? ' is-disabled' : '')} title={title}>
      <input
        type={'checkbox'}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className={'track'} />
      {label ? <span>{label}</span> : null}
    </label>
  )
}

export type BadgeTone = 'default' | 'green' | 'red' | 'amber' | 'gray'

export interface BadgeProps {
  tone?: BadgeTone
  title?: string
  children: React.ReactNode
}

export function Badge({ tone = 'default', title, children }: BadgeProps): React.JSX.Element {
  return (
    <span className={'gth-badge' + (tone === 'default' ? '' : ' ' + tone)} title={title}>
      {children}
    </span>
  )
}

/**
 * 防抖检索框: 输入状态留在组件内部(父级不随每次按键重渲染),
 * 停止输入 300ms 或回车后才把值交给父级去查询。
 */
export function SearchInput({
  value,
  onApply,
  placeholder,
  maxWidth = 240
}: {
  value: string
  onApply: (v: string) => void
  placeholder: string
  maxWidth?: number
}): React.JSX.Element {
  const [draft, setDraft] = useState(value)

  // 外部重置(如「清除筛选」)时同步回输入框
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 外部值变化同步输入框
    setDraft(value)
  }, [value])

  // 停止输入 300ms 后自动检索
  useEffect(() => {
    if (draft.trim() === value.trim()) return
    const timer = window.setTimeout(() => onApply(draft.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [draft, value, onApply])

  return (
    <input
      className={'ui-input gth-input'}
      style={{ maxWidth }}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onApply(draft.trim())
      }}
    />
  )
}

/**
 * 空态与错误条：**实现已上移到 components/ui/Feedback.tsx**（客户页/数据页/看板都要用同一套），
 * 这里只做转出，营销页的调用点一行都不用改。
 *
 * 注: 旧的 .gth-empty / .gth-error 两套样式已删除 —— 需要新写空态时请用 ui 版，
 * 别再在页面里造第三份（此前同一句「没有数据」在四个页面是四种长相）。
 */
export { Empty as EmptyState, ErrBar } from '../ui/Feedback'
export type { EmptyProps as EmptyStateProps, ErrBarProps } from '../ui/Feedback'

// ── 指标与状态 ──
