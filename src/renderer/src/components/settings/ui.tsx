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

/**
 * 状态胶囊:一眼看清「开没开 / 通没通」,替代原来那句一长串数字的口语状态。
 * tone 只管颜色语义,文案由调用方给(避免组件里散落业务判断)。
 */
export function StatusPill({
  tone = 'off',
  text,
  title
}: {
  tone?: 'ok' | 'off' | 'warn' | 'bad'
  text: string
  title?: string
}): React.JSX.Element {
  return (
    <span className={`sf-pill is-${tone}`} title={title}>
      {text}
    </span>
  )
}

/** 状态胶囊行:多个胶囊横向排列,窄屏自动换行 */
export function PillRow({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="sf-pills">{children}</div>
}

/** 折叠区(高级/排查用):默认收起,避免把列名映射、标识、历史堆在首屏 */
export function AdvancedBlock({
  label = '高级信息（排查用）',
  children
}: {
  label?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <details className="sf-adv">
      <summary>{label}</summary>
      <div className="sf-adv-body">{children}</div>
    </details>
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
