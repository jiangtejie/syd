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

export interface EmptyStateProps {
  title: string
  steps?: string[]
  extra?: React.ReactNode
}

export function EmptyState({ title, steps, extra }: EmptyStateProps): React.JSX.Element {
  return (
    <div className={'gth-empty'}>
      <div>{title}</div>
      {steps && steps.length > 0 ? (
        <div className={'steps'}>
          {steps.map((s, i) => (
            <div className={'step'} key={s}>
              <span className={'no'}>{i + 1}</span>
              <span>{s}</span>
            </div>
          ))}
        </div>
      ) : null}
      {extra}
    </div>
  )
}

export interface ErrBarProps {
  msg: string
  onRetry?: () => void
}

export function ErrBar({ msg, onRetry }: ErrBarProps): React.JSX.Element {
  return (
    <div className={'gth-error'}>
      <span className={'msg'} title={msg}>
        {msg}
      </span>
      {onRetry ? (
        <button className={'ui-btn gth-btn sm'} type={'button'} onClick={onRetry}>
          重试
        </button>
      ) : null}
    </div>
  )
}

// ── 指标与状态 ──
