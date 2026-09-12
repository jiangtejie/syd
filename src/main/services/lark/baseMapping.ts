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

/**
 * 列名映射：本地标准列名 → 目标表里的实际列名。
 * 用于把议题写进**用户自己已有的表**（他们的列名可能叫「问题描述」「负责人」）。
 * 没有映射的列沿用标准名。
 */
export type FieldMap = Record<string, string>

/** 取映射后的列名（空/空白视为未映射） */
export function mapFieldName(local: string, map?: FieldMap): string {
  const hit = map?.[local]
  return hit && hit.trim() ? hit.trim() : local
}

/** 议题 → Base 字段（默认脱敏：只有标题/摘要，不推聊天原文；列名按 fieldMap 重写） */
export function issueToFields(
  i: FeedbackIssue,
  names: Map<string, string>,
  opts: { fieldMap?: FieldMap; primaryField?: string } = {}
): Record<string, unknown> {
  const standard: Record<string, unknown> = {
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
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(standard)) out[mapFieldName(k, opts.fieldMap)] = v
  // 飞书数据表第一列是主字段（不可删除/改类型）：若它不在标准列里，额外把标题写进去，
  // 同事在手机上第一眼看到的就是问题标题，而不是空列。
  const pf = (opts.primaryField ?? '').trim()
  if (pf && !(pf in out)) out[pf] = (i.title ?? '').slice(0, 240)
  return out
}

export function hashOf(fields: Record<string, unknown>): string {
  return createHash('sha1').update(JSON.stringify(fields)).digest('hex').slice(0, 16)
}

/** Base 记录里我们关心（可回写）的列：状态 / 跟进人 / 处理备注 */
export interface RemoteCollab {
  status: string
  assignee: string
  note: string
}

export function collabOf(
  fields: Record<string, unknown> | undefined,
  map?: FieldMap
): RemoteCollab {
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
  return {
    status: text(f[mapFieldName('状态', map)]),
    assignee: text(f[mapFieldName('跟进人', map)]),
    note: text(f[mapFieldName('处理备注', map)])
  }
}

export interface CollabDiff {
  statusChanged: boolean
  assigneeChanged: boolean
  noteChanged: boolean
  /** 是否有任何一列被同事改过 */
  any: boolean
}

/**
 * 与「上次同步时 Base 上的值」比对：变了说明是同事在表格里改的。
 * 「状态」为空时不视为改动 —— 同事把单选清掉不该把本地状态也清掉。
 */
export function diffCollab(
  remote: RemoteCollab,
  lastKnown: { status: string; assignee: string; note: string } | null
): CollabDiff {
  const prev = lastKnown ?? { status: '', assignee: '', note: '' }
  const statusChanged = !!remote.status && remote.status !== prev.status
  const assigneeChanged = remote.assignee !== prev.assignee
  const noteChanged = remote.note !== prev.note
  return {
    statusChanged,
    assigneeChanged,
    noteChanged,
    any: statusChanged || assigneeChanged || noteChanged
  }
}

// ── 数字员工回复（影子记录）→ Base ──

/** 决策来源 → Base 单选文案 */
export const DECISION_TEXT: Record<string, string> = {
  script: '命中话术',
  llm: 'LLM 兜底',
  handoff: '转人工'
}

/** 人工反馈（本地）→ Base 单选文案 */
export const FEEDBACK_TEXT: Record<string, string> = {
  good: '答得对',
  bad: '答错了',
  'no-reply': '不该回'
}

/** 风险等级 → Base 单选文案 */
export function riskText(level: string | undefined): string {
  if (level === 'B') return 'B 需确认'
  if (level === 'C') return 'C 禁自动'
  return 'A 可自动'
}

export interface ReplyLike {
  id: number
  groupName: string
  groupUsername: string
  triggerText: string
  decision: string
  intent: string
  replyText: string
  riskLevel: string
  status: string
  feedback: string
  triggerTime?: number
  createdAt: number
}

/**
 * 影子/待审回复 → Base 字段。
 * 触发消息按 `triggerChars` 截断：审核「回得对不对」需要看到客户原话，但不必全量外发 ——
 * 默认 120 字；设置里打开「推送聊天原文」后放宽到 500。
 */
export function replyToFields(r: ReplyLike, triggerChars = 120): Record<string, unknown> {
  return {
    回复ID: String(r.id),
    客户群: r.groupName || r.groupUsername,
    触发消息: (r.triggerText ?? '').slice(0, triggerChars),
    判定: DECISION_TEXT[r.decision] ?? r.decision,
    意图: r.intent || '',
    拟回复: (r.replyText ?? '').slice(0, 900),
    风险: riskText(r.riskLevel),
    状态: r.status === 'sent' ? '已发送' : r.status === 'rejected' ? '已驳回' : '影子（待看）',
    人工反馈: FEEDBACK_TEXT[r.feedback] ?? '',
    时间: r.triggerTime ?? r.createdAt
  }
}
