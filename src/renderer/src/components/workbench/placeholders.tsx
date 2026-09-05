/** 轻量占位组件:加载骨架与空状态提示(会话/消息/面板通用) */

export function SkeletonLines({ rows = 3 }: { rows?: number }): React.JSX.Element {
  return (
    <div className="ph-skeleton" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className={`ph-skel-line${i % 3 === 2 ? ' short' : ''}`} />
      ))}
    </div>
  )
}

export function EmptyHint({
  icon = '💬',
  title,
  desc,
  children
}: {
  icon?: string
  title: string
  desc?: string
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="ph-empty">
      <div className="ph-empty-icon">{icon}</div>
      <div className="ph-empty-title">{title}</div>
      {desc && <div className="ph-empty-desc">{desc}</div>}
      {children}
    </div>
  )
}
