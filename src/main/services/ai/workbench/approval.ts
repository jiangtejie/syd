import { emitWorkbenchEvent } from './events'

/**
 * 确认桥(CipherTalk toolApproval 改良):引擎内工具执行前请求人工确认。
 * - 事件 → 渲染端按钮(允许/拒绝);超时视为拒绝,不阻塞会话;
 * - 只读工具不经过本桥(v1 全只读,为 v2 写操作预留)。
 */

interface Pending {
  resolve: (ok: boolean) => void
  timer: NodeJS.Timeout
}

const pending = new Map<string, Pending>()
let seq = 0

export function requestToolApproval(
  sessionId: number,
  toolName: string,
  argsClip: string,
  timeoutMs = 60_000
): Promise<boolean> {
  const runId = `wb-ap-${++seq}`
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(runId)
      resolve(false)
    }, timeoutMs)
    pending.set(runId, { resolve, timer })
    emitWorkbenchEvent(sessionId, {
      type: 'approval',
      runId,
      tool: toolName,
      args: argsClip,
      approvalText: `工具 ${toolName} 需要确认后执行:${argsClip}`,
      toolStatus: 'pending'
    })
  })
}

/** IPC 回传:允许/拒绝 */
export function resolveToolApproval(runId: string, ok: boolean): boolean {
  const entry = pending.get(runId)
  if (!entry) return false
  clearTimeout(entry.timer)
  pending.delete(runId)
  entry.resolve(ok)
  return true
}
