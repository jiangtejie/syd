import { emitWorkbenchEvent } from './events'
import { getConfig, setConfig } from '../../../db/repos/config'

/**
 * 确认桥(CipherTalk toolApproval 改良):引擎内工具执行前请求人工确认。
 * - 事件 → 渲染端按钮(允许/拒绝);超时视为拒绝,不阻塞会话;
 * - 只读工具不经过本桥(v1 全只读,本桥服务 v2 写/外部工具,并支持偏好直通);
 * - 审批策略(可记忆):
 *     mode: ask | allow | deny(全局默认,ask=每次询问)
 *     allow/deny 名单:app_config JSON 数组(始终允许/始终拒绝的工具)
 *     会话级「本轮允许」:内存表,生命周期=进程(随引擎运行期,切会话不丢失该轮设置)
 */

export type ToolApprovalMode = 'ask' | 'allow' | 'deny'

const CFG_MODE = 'wb.approval.mode'
const CFG_ALLOW = 'wb.approval.allow'
const CFG_DENY = 'wb.approval.deny'

/** 审批结果：把「超时」与「明确拒绝」分开 —— 两者都等于不执行，但对用户/模型的解释完全不同 */
export type ApprovalOutcome = 'allow' | 'deny' | 'timeout' | 'aborted'

interface Pending {
  resolve: (outcome: ApprovalOutcome) => void
  timer: NodeJS.Timeout
}

const pending = new Map<string, Pending>()
let seq = 0

/** 会话级「本轮允许」工具集(进程内;清理随会话删除由引擎调用) */
const sessionAllowed = new Map<number, Set<string>>()

function listConfig(key: string): string[] {
  const raw = getConfig(key)
  if (!raw) return []
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function saveList(key: string, names: string[]): void {
  setConfig(key, JSON.stringify([...new Set(names.filter((n) => n && n.trim()))]))
}

export function getToolApprovalPrefs(): {
  mode: ToolApprovalMode
  allow: string[]
  deny: string[]
} {
  const modeRaw = getConfig(CFG_MODE)
  const mode: ToolApprovalMode = modeRaw === 'allow' || modeRaw === 'deny' ? modeRaw : 'ask'
  return { mode, allow: listConfig(CFG_ALLOW), deny: listConfig(CFG_DENY) }
}

/** 设置全局偏好(模式 + 名单);名单变更立即对所有会话生效 */
export function setToolApprovalPrefs(prefs: {
  mode: ToolApprovalMode
  allow: string[]
  deny: string[]
}): void {
  setConfig(CFG_MODE, prefs.mode === 'allow' || prefs.mode === 'deny' ? prefs.mode : 'ask')
  saveList(CFG_ALLOW, prefs.allow)
  saveList(CFG_DENY, prefs.deny)
}

/** 会话级「本轮允许」:登记后该会话本轮后续调用免确认 */
export function setSessionToolAllowed(sessionId: number, toolName: string, on: boolean): void {
  if (!toolName) return
  const cur = sessionAllowed.get(sessionId) ?? new Set<string>()
  if (on) cur.add(toolName)
  else cur.delete(toolName)
  if (cur.size > 0) sessionAllowed.set(sessionId, cur)
  else sessionAllowed.delete(sessionId)
}

/** 会话删除/账号切换时清理本轮登记 */
export function clearSessionToolAllowed(sessionId: number): void {
  sessionAllowed.delete(sessionId)
}

function toolDecision(sessionId: number, toolName: string): 'allow' | 'deny' | 'ask' {
  if (sessionAllowed.get(sessionId)?.has(toolName)) return 'allow'
  const prefs = getToolApprovalPrefs()
  if (prefs.allow.includes(toolName)) return 'allow'
  if (prefs.deny.includes(toolName)) return 'deny'
  return prefs.mode // ask | allow | deny
}

/**
 * 审批判定(供其它引擎复用):allow=直通(完全访问) / deny=始终拒绝 / ask=需人工确认。
 * 优先级:会话本轮允许 > 工具始终允许名单 > 工具始终拒绝名单 > 全局模式。
 */
export function approvalDecision(sessionId: number, toolName: string): 'allow' | 'deny' | 'ask' {
  return toolDecision(sessionId, toolName)
}

export function requestToolApproval(
  sessionId: number,
  toolName: string,
  argsClip: string,
  timeoutMs = 60_000,
  signal?: AbortSignal
): Promise<ApprovalOutcome> {
  const decision = toolDecision(sessionId, toolName)
  if (decision === 'allow') return Promise.resolve('allow') // 偏好直通:不打扰
  if (decision === 'deny') return Promise.resolve('deny') // 偏好拒绝:直接跳过

  const runId = `wb-ap-${++seq}`
  return new Promise<ApprovalOutcome>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(runId)
      // 超时 ≠ 用户拒绝：以前两者都回「用户拒绝了本次操作」，于是「没人看审批卡」被
      // 读成「用户在驳回」，模型据此反复换写法（实测任务 5 里连刷 6 次「用户拒绝」）
      resolve('timeout')
    }, timeoutMs)
    // 用户点了停止：审批卡不再有意义，立刻按「未获确认」收尾（否则要干等到超时，
    // 表现就是「点了停止还挂着」）
    if (signal) {
      const onAbort = (): void => {
        clearTimeout(timer)
        pending.delete(runId)
        resolve('aborted')
      }
      if (signal.aborted) {
        clearTimeout(timer)
        resolve('aborted')
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
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

/** IPC 回传:允许/拒绝(单次) */
export function resolveToolApproval(runId: string, ok: boolean): boolean {
  const entry = pending.get(runId)
  if (!entry) return false
  clearTimeout(entry.timer)
  pending.delete(runId)
  entry.resolve(ok ? 'allow' : 'deny')
  return true
}
