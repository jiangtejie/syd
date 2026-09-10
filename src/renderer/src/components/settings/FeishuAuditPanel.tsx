import { AuditRowItem } from './auditView'
import { fmtAuditTime, useAuditPolling } from './useAuditPolling'

/**
 * 飞书指令审计(桌面端只读):谁在飞书下了什么、是否被接收策略拒绝、执行成功还是失败。
 * 与「飞书任务」同一张表 —— 这里含被拦下的消息,用于排查「为什么机器人没反应」。
 */

const KIND_TEXT: Record<string, string> = {
  command: '指令',
  message: '消息',
  rejected: '被拒'
}

const STATUS_TEXT: Record<string, string> = {
  running: '执行中',
  queued: '排队中',
  done: '已完成',
  ok: '成功',
  error: '失败',
  failed: '失败',
  cancelled: '已取消',
  skipped: '已拦截'
}

export function FeishuAuditPanel(): React.JSX.Element {
  const { logs, err } = useAuditPolling(50, false)
  const rejected = (logs ?? []).filter((l) => l.kind === 'rejected').length

  return (
    <div className="st-grid wb-skills-full">
      <div className="st-hint">
        最近 50 条入站记录(10 秒刷新)。被接收策略拦下的消息也会留痕,便于排查「为什么机器人没反应」。
        本页共 {logs?.length ?? 0} 条,其中被拒 {rejected} 条。
      </div>
      {err && <div className="st-bad">✗ {err}</div>}
      {logs === null && <div className="st-hint">加载中…</div>}
      {logs !== null && logs.length === 0 && <div className="st-hint">还没有入站记录。</div>}
      {logs !== null &&
        logs.map((l) => (
          <AuditRowItem
            key={l.id}
            badge={KIND_TEXT[l.kind] ?? l.kind}
            badgeClass={
              l.kind === 'rejected'
                ? 'mcp-off'
                : l.status === 'ok' || l.status === 'done'
                  ? 'mcp-on'
                  : 'mcp-kind'
            }
            title={l.senderOpenId ? l.senderOpenId.slice(0, 10) : '-'}
            desc={[
              l.text ? l.text.replace(/\s+/g, ' ').slice(0, 40) : '(非文本)',
              STATUS_TEXT[l.status] ?? l.status,
              l.elapsedMs > 0 ? `${(l.elapsedMs / 1000).toFixed(1)}s` : '',
              l.tools,
              l.error ? l.error.slice(0, 40) : '',
              fmtAuditTime(l.createdAt, true)
            ]
              .filter(Boolean)
              .join(' · ')}
          />
        ))}
    </div>
  )
}
