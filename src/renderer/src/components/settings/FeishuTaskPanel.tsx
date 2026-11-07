import { AuditRowItem } from './auditView'
import { fmtAuditDur, fmtAuditTime, useAuditPolling } from './useAuditPolling'

/**
 * 飞书指令任务(桌面端只读):谁在飞书下了什么指令、执行到哪一步、结果如何。
 * 与「飞书指令审计」同一张表 —— 这里只看任务(不含被接收策略拒绝的消息)。
 * 取消请在飞书会话里发 /cancel;可用能力见 /help。
 */

const STATUS_TEXT: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
  ok: '已完成',
  error: '失败',
  skipped: '已拦截'
}

export function FeishuTaskPanel(): React.JSX.Element {
  const { logs, err } = useAuditPolling(20, true, 5000)
  const running = (logs ?? []).filter((t) => t.status === 'running' || t.status === 'queued').length

  return (
    <div className="st-grid wb-skills-full">
      <div className="st-hint">
        飞书里发指令后,任务会在这里留痕(每 5 秒刷新)。当前执行中:{running} 个。 取消请在飞书会话发
        /cancel;查看能力清单发 /help。
      </div>
      {err && <div className="st-bad">✗ {err}</div>}
      {logs === null && <div className="st-hint">加载中…</div>}
      {logs !== null && logs.length === 0 && (
        <div className="st-empty is-sm">
          <div className="st-empty-glyph" aria-hidden="true">
            ◇
          </div>
          <div className="st-empty-title">还没有执行记录</div>
          <div className="st-empty-desc">
            在飞书里对机器人发一句指令试试，任务会实时出现在这里。
          </div>
        </div>
      )}
      {logs !== null &&
        logs.map((t) => (
          <AuditRowItem
            key={t.id}
            badge={`#${t.id} ${STATUS_TEXT[t.status] ?? t.status}`}
            badgeClass={
              t.status === 'done' || t.status === 'ok'
                ? 'mcp-on'
                : t.status === 'failed' || t.status === 'error'
                  ? 'mcp-off'
                  : 'mcp-kind'
            }
            title={t.text.slice(0, 46) || '(无正文)'}
            desc={[
              t.startedAt ? fmtAuditDur(t.startedAt, t.finishedAt) : '',
              t.status === 'running' && t.progress ? t.progress.slice(0, 40) : '',
              t.status === 'failed' && t.error ? t.error.slice(0, 40) : '',
              t.status === 'done' && t.result
                ? `结果 ${t.result.replace(/\s+/g, ' ').slice(0, 40)}…`
                : '',
              fmtAuditTime(t.createdAt)
            ]
              .filter(Boolean)
              .join(' · ')}
          />
        ))}
    </div>
  )
}
