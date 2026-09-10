/**
 * 审计/任务行(状态徽标 + 标题 + 描述):
 * 「飞书任务」与「飞书指令审计」共用同一行结构,只有徽标与描述由调用方拼装。
 */
export function AuditRowItem(props: {
  badge: string
  badgeClass: string
  title: string
  desc: string
}): React.JSX.Element {
  return (
    <div className="mcp-item">
      <div className="mcp-item-main">
        <span className={props.badgeClass}>{props.badge}</span>
        <b>{props.title}</b>
        <span className="mcp-desc">{props.desc}</span>
      </div>
    </div>
  )
}
