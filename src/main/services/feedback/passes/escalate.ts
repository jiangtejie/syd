import { listFeedbackIssues } from '../analyzer'
import { notifyIssueAlert, type AlertIssue } from '../../lark/notify'
import {
  cfgHours,
  ESCALATE_ASSIGNED_KEY,
  ESCALATE_UNASSIGNED_KEY,
  ESCALATE_URGENT_KEY,
  escalateEnabled,
  issueLog,
  sendChanged
} from './shared'

/**
 * 通道 C：盯办升级（每轮巡检都跑）。
 *
 * 命中条件（正式口径，排除疑似）：
 * - 未指派超阈值：紧急 > issue.escalateUrgentHours(默认1h) / 其余 > issue.escalateUnassignedHours(默认4h)；
 * - 已指派但**从未有人回复过**且超 issue.escalateAssignedHours(默认8h) → 已指派未处理；
 *   （已回复的走「跟进超时」，避免正在等客户确认的议题被反复催办）
 * - 跟进超时：monitor.followUpHours 已由 listIssues 算好 followUpOverdue。
 *
 * 命中且超过该问题的退避间隔即广播 escalate（渲染端未聚焦时桌面提醒）+ 飞书推送。
 * 退避：同一条问题第 n 次提醒间隔递增（45min → 90min → 3h → 6h），不再每 45 分钟轰炸一次。
 */

/** 同一问题的重复提醒间隔梯度：越催越慢 */
const ESCALATE_BACKOFF_MS = [45 * 60_000, 90 * 60_000, 3 * 3600_000, 6 * 3600_000]
/** 提醒记录保留时长：超过即清理（问题闭环后其键不再增长） */
const ESCALATE_KEEP_MS = 24 * 3600_000

const running = new Set<string>()
const notifiedAt = new Map<string, { at: number; times: number }>()

/** 问题对象 → 飞书告警条目（只带必要字段） */
function toAlertIssue(i: {
  id: number
  type: string
  title: string
  severity?: string
  groupName: string
  occurAt: number
  assignee?: string
}): AlertIssue {
  return {
    id: i.id,
    type: i.type,
    title: i.title,
    severity: i.severity,
    groupName: i.groupName,
    occurAt: i.occurAt,
    assignee: i.assignee
  }
}

/** 一轮盯办检查 */
export async function runEscalatePass(wxid: string): Promise<void> {
  if (running.has(wxid) || !escalateEnabled()) return
  running.add(wxid)
  try {
    const now = Date.now()
    const unassignedMs = cfgHours(ESCALATE_UNASSIGNED_KEY, 4) * 3600_000
    const urgentMs = cfgHours(ESCALATE_URGENT_KEY, 1) * 3600_000
    const assignedMs = cfgHours(ESCALATE_ASSIGNED_KEY, 8) * 3600_000
    // 清理过期提醒记录（量小，每轮顺带扫一遍）
    for (const [k, v] of notifiedAt) {
      if (now - v.at > ESCALATE_KEEP_MS) notifiedAt.delete(k)
    }
    const all = listFeedbackIssues(wxid)
    const items = all.filter((i) => i.status === 'open' && !i.needConfirm)
    const fresh: Array<{ id: number; reason: string }> = []
    for (const i of items) {
      let reason = ''
      const age = now - i.occurAt
      if (!i.assignee) {
        const t = i.severity === '紧急' ? urgentMs : unassignedMs
        if (age >= t) reason = i.severity === '紧急' ? '紧急问题未指派' : '问题未指派'
      } else if (!i.followUp && age >= assignedMs) {
        reason = '已指派未处理'
      }
      if (!reason && i.followUpOverdue) reason = '跟进超时'
      if (!reason) continue
      const key = `${wxid}|${i.id}|${reason}`
      const hit = notifiedAt.get(key)
      const wait = ESCALATE_BACKOFF_MS[Math.min(hit?.times ?? 0, ESCALATE_BACKOFF_MS.length - 1)]
      if (!hit || now - hit.at >= wait) {
        notifiedAt.set(key, { at: now, times: (hit?.times ?? 0) + 1 })
        fresh.push({ id: i.id, reason })
      }
    }
    if (fresh.length > 0) {
      sendChanged(wxid, { escalate: fresh.length })
      issueLog.info(`盯办升级 ${wxid} n=${fresh.length} items=${fresh.map((f) => f.id).join(',')}`)
      try {
        const byId = new Map(all.map((i) => [i.id, i]))
        const alertItems: AlertItem[] = []
        for (const f of fresh) {
          const i = byId.get(f.id)
          if (i) alertItems.push({ ...toAlertIssue(i), reason: f.reason })
        }
        if (alertItems.length > 0) {
          void notifyIssueAlert({ kind: 'issue_escalate', wxid, issues: alertItems })
        }
      } catch (e) {
        issueLog.warn(`飞书推送(盯办)失败 ${wxid}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  } catch (e) {
    issueLog.error(`盯办巡检异常 ${wxid}`, e)
  } finally {
    running.delete(wxid)
  }
}

type AlertItem = AlertIssue & { reason: string }

/** 停止调度时清空进程内状态 */
export function resetEscalateState(): void {
  running.clear()
  notifiedAt.clear()
}
