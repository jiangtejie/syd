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
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 10,
        padding: '28px 20px',
        textAlign: 'center'
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 600 }}>还没有连接微信数据</div>
      <div style={{ fontSize: 13, color: 'var(--text-2)', maxWidth: 460, lineHeight: 1.7 }}>
        {detail ?? `连接后这里会显示${what}。`}
      </div>
      <button type="button" className="ui-btn is-primary" onClick={() => setPage('settings')}>
        去设置导入密钥并连接
      </button>
      <div style={{ fontSize: 12, color: 'var(--text-3)', maxWidth: 460, lineHeight: 1.7 }}>
        密钥需要用外部工具从本机微信导出 64 位十六进制串，再粘贴进「设置 → 微信数据与密钥」。
      </div>
    </div>
  )
}

export default ConnectGuide
