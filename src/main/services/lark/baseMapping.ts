import { createHash } from 'crypto'
import type { FeedbackIssue, FeedbackIssueStatus } from '../../../shared/types'

/**
 * 议题 ↔ 飞书多维表格的**字段映射**（纯函数，零 IO，可自检）。
 *
 * 拆出来的原因：映射错一个值就是「同事在手机上点了已解决，本地没变」这类无声故障，
 * 必须能脱离数据库与网络单独测。
 */

/** 本地状态 → Base 单选文案（open 还要区分「跟进中」：客户在等 vs 有人在跟） */
export const STATUS_TEXT: Record<string, string> = {
  open: '待处理',
  done: '已解决',
  stalled: '已搁置',
  archived: '不是问题'
}

/** Base 单选文案 → 本地状态。'跟进中' 落到 open（follow_up 由引擎判定，不由表格决定） */
export function statusFromText(text: string): FeedbackIssueStatus | null {
  const t = (text ?? '').trim()
  if (t === '待处理' || t === '跟进中') return 'open'
  if (t === '已解决') return 'done'
  if (t === '已搁置') return 'stalled'
  if (t === '不是问题' || t === '已归档') return 'archived'
  return null
}

export function statusText(i: Pick<FeedbackIssue, 'status' | 'followUp'>): string {
  if (i.status === 'open') return i.followUp ? '跟进中' : '待处理'
  return STATUS_TEXT[i.status] ?? '待处理'
}

/** 跟进人展示名：命中团队名单用名单里的称呼，否则原样（同事在表格里自己填的名字） */
export function assigneeText(assignee: string | undefined, names: Map<string, string>): string {
  if (!assignee) return ''
  return names.get(assignee) || assignee
}

/**
 * 反向：Base 里的「跟进人」→ 本地 assignee。
 * 优先按团队名单的称呼/username 精确匹配；匹配不到就把原文当跟进人记下来 ——
 * 同事在手机上写自己名字时不该被系统拒之门外，显示成名字比显示成空更有用。
 */
export function assigneeFromText(
  text: string,
  members: Array<{ username: string; label: string }>
): string | null {
  const t = (text ?? '').trim()
  if (!t) return null
  const hit = members.find((m) => (m.label || '').trim() === t || m.username === t)
  return hit ? hit.username : t
}

/** 议题 → Base 字段（默认脱敏：只有标题/摘要，不推聊天原文） */
export function issueToFields(
  i: FeedbackIssue,
  names: Map<string, string>
): Record<string, unknown> {
  return {
    议题ID: String(i.id),
    客户群: i.groupName || i.groupUsername,
    类型: i.type,
    严重度: i.severity ?? '一般',
    标题: (i.title ?? '').slice(0, 240),
    摘要: (i.summary ?? '').slice(0, 900),
    状态: statusText(i),
    跟进人: assigneeText(i.assignee, names),
    首现时间: i.occurAt,
    最近更新: i.updatedAt,
    证据条数: i.msgCount
  }
}

export function hashOf(fields: Record<string, unknown>): string {
  return createHash('sha1').update(JSON.stringify(fields)).digest('hex').slice(0, 16)
}

/** Base 记录里我们关心（可回写）的三列 */
export interface RemoteCollab {
  status: string
  assignee: string
}

export function collabOf(fields: Record<string, unknown> | undefined): RemoteCollab {
  const f = fields ?? {}
  const text = (v: unknown): string => {
    if (typeof v === 'string') return v.trim()
    // 单选/人员等字段可能是数组或对象（附件/人员字段）
    if (Array.isArray(v))
      return v
        .map((x) => text(x))
        .filter(Boolean)
        .join(' ')
        .trim()
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      return text(o.text ?? o.name ?? o.value ?? '')
    }
    return ''
  }
  return { status: text(f['状态']), assignee: text(f['跟进人']) }
}

export interface CollabDiff {
  statusChanged: boolean
  assigneeChanged: boolean
}

/** 与「上次同步时 Base 上的值」比对：变了说明是同事在表格里改的 */
export function diffCollab(
  remote: RemoteCollab,
  lastKnown: { status: string; assignee: string } | null
): CollabDiff {
  const prev = lastKnown ?? { status: '', assignee: '' }
  return {
    statusChanged: !!remote.status && remote.status !== prev.status,
    assigneeChanged: remote.assignee !== prev.assignee
  }
}
