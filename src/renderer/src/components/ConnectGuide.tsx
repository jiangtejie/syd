import { useWorkbenchStore } from '../stores/workbench'

/**
 * 统一的「还没连上微信」空态。
 *
 * 为什么要有它：未连接是**首日必现**的状态，而此前每个页面各写一句 —— 客户页是一句不可点的
 * 纯文本、监控页把解释塞进副标题、对话页做了 banner。用户在四个页面看到四句不同的话，
 * 得到的结论是「这软件坏了」，而不是「我需要去设置里做一件事」。
 */
export function ConnectGuide({
  what,
  detail
}: {
  /** 这个页面连接后会显示什么（填进默认文案） */
  what: string
  /** 覆盖默认说明 */
  detail?: string
}): React.JSX.Element {
  const setPage = useWorkbenchStore((s) => s.setPage)
  return (
    <div className="ui-empty">
      {/* 图标：数据接口（两个插头对接），比"人形占位"更贴「连接数据源」的语义 */}
      <div className="ui-empty-glyph" aria-hidden="true">
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M9 7V3M15 7V3" />
          <path d="M6 7h12v3a6 6 0 0 1-6 6v0a6 6 0 0 1-6-6z" />
          <path d="M12 16v5" />
        </svg>
      </div>
      <div className="ui-empty-title">还没有连接微信数据</div>
      <div className="ui-empty-desc">{detail ?? `连接后这里会显示${what}。`}</div>
      <button type="button" className="ui-btn is-primary" onClick={() => setPage('settings')}>
        去设置导入密钥并连接
      </button>
      <div className="ui-empty-hint">
        密钥需要用外部工具从本机微信导出 64 位十六进制串，再粘贴进「设置 → 微信数据与密钥」。
      </div>
    </div>
  )
}

export default ConnectGuide
