import type { ReactNode } from 'react'

/**
 * 设置页 UI 基元:卡片(标题/说明)与开关。
 * 所有 tab 统一用组件而不是零散手写样式,保证布局一致;
 * 纯展示,不含业务逻辑,开关只转发 checked 状态。
 */

export function SettingsCard({
  title,
  desc,
  children,
  className = ''
}: {
  title?: string
  desc?: string
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <section className={`page-card st-section sf-card${className ? ` ${className}` : ''}`}>
      {(title || desc) && (
        <header className="sf-card-head">
          {title && <div className="sf-card-title">{title}</div>}
          {desc && <div className="sf-card-desc">{desc}</div>}
        </header>
      )}
      <div className="sf-card-body">{children}</div>
    </section>
  )
}

/** 胶囊开关(role=switch,键盘可操作) */
export function Switch({
  checked,
  onChange,
  disabled = false,
  label
}: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  label?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`sf-switch${checked ? ' is-on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="sf-switch-knob" />
    </button>
  )
}

/** 一行:左文(标题+可选说明) + 右侧开关 */
export function SwitchRow({
  label,
  desc,
  checked,
  onChange,
  disabled = false
}: {
  label: string
  desc?: string
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <div className="sf-switch-row">
      <div className="sf-switch-text">
        <span className="sf-switch-label">{label}</span>
        {desc && <span className="sf-switch-desc">{desc}</span>}
      </div>
      <Switch checked={checked} onChange={onChange} disabled={disabled} label={label} />
    </div>
  )
}

/** 表单行:左标签 + 控件 + 可选行内说明(文本/数字等沿用既有 st-* 控件) */
export function FieldRow({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <label className="st-row">
      <span className="st-label">{label}</span>
      {children}
      {hint && <span className="st-hint-inline">{hint}</span>}
    </label>
  )
}
