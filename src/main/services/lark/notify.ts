import { getConfig, getConfigBoolean, getConfigNumber, setConfig } from '../../db/repos/config'
import {
  countFeishuSentToday,
  insertFeishuSendLog,
  listFeishuSendLogs,
  type FeishuSendLogRow
} from '../../db/repos/feishuSendLogRepo'
import { createLogger } from '../logging'
import { sendImText, type FeishuReceiveIdType } from './im'

/**
 * 飞书告警推送(机器人身份,只读业务数据不外发细节的克制口径)。
 * - 目标存 config(`feishu.notify.targets` JSON):群 chat_id 或个人 open_id,各带展示名;
 * - 事件开关:`feishu.notify.events` = issue_new,issue_escalate;
 * - 治理:日限额(`feishu.notify.dailyLimit`,默认 200)+ 事件级节流 + 幂等键 + 审计落库;
 * - 失败只记日志与审计,绝不阻塞问题分析主流程(调用方 fire-and-forget)。
 */

const log = createLogger('feishu-notify')

const KEY_ENABLED = 'feishu.notify.enabled'
const KEY_TARGETS = 'feishu.notify.targets'
const KEY_EVENTS = 'feishu.notify.events'
const KEY_DAILY = 'feishu.notify.dailyLimit'

/** 事件级节流:同类告警最小间隔(防刷屏) */
const EVENT_MIN_GAP_MS = 60_000
const MAX_TARGETS = 20

export type FeishuNotifyEvent = 'issue_new' | 'issue_escalate'

export interface FeishuNotifyTarget {
  kind: 'chat' | 'user'
  id: string
  name: string
}

export interface FeishuNotifyConfig {
  enabled: boolean
  targets: FeishuNotifyTarget[]
  events: FeishuNotifyEvent[]
  dailyLimit: number
}

function readTargets(): FeishuNotifyTarget[] {
  const raw = (getConfig(KEY_TARGETS) ?? '').trim()
  if (!raw) return []
  try {
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return []
    const out: FeishuNotifyTarget[] = []
    for (const it of arr) {
      const o = it as Record<string, unknown>
      const kind = o?.kind === 'chat' ? 'chat' : o?.kind === 'user' ? 'user' : null
      const id = typeof o?.id === 'string' ? o.id.trim() : ''
      if (!kind || !id) continue
      out.push({ kind, id, name: typeof o?.name === 'string' ? o.name.trim() : '' })
    }
    return out.slice(0, MAX_TARGETS)
  } catch {
    return []
  }
}

function writeTargets(list: FeishuNotifyTarget[]): void {
  setConfig(KEY_TARGETS, JSON.stringify(list.slice(0, MAX_TARGETS)))
}

function readEvents(): FeishuNotifyEvent[] {
  const raw = (getConfig(KEY_EVENTS) ?? 'issue_new,issue_escalate').trim()
  const out: FeishuNotifyEvent[] = []
  if (raw.includes('issue_new')) out.push('issue_new')
  if (raw.includes('issue_escalate')) out.push('issue_escalate')
  return out
}

export function getFeishuNotifyConfig(): FeishuNotifyConfig {
  return {
    enabled: getConfigBoolean(KEY_ENABLED, false),
    targets: readTargets(),
    events: readEvents(),
    dailyLimit: Math.min(Math.max(getConfigNumber(KEY_DAILY, 200), 1), 2000)
  }
}

export function setFeishuNotifyEnabled(on: boolean): void {
  setConfig(KEY_ENABLED, on ? '1' : '0')
}

export function setFeishuNotifyEvent(evt: FeishuNotifyEvent, on: boolean): void {
  const set = new Set(readEvents())
  if (on) set.add(evt)
  else set.delete(evt)
  setConfig(KEY_EVENTS, [...set].sort().join(','))
}

/** 新增接收目标(kind+id 去重;id 需符合飞书前缀) */
export function addFeishuNotifyTarget(input: {
  kind: 'chat' | 'user'
  id: string
  name?: string
}): { ok: boolean; error?: string; targets?: FeishuNotifyTarget[] } {
  const id = (input.id ?? '').trim()
  if (!id) return { ok: false, error: '请填写 chat_id 或 open_id' }
  if (input.kind === 'chat' && !/^oc_[A-Za-z0-9]+$/.test(id)) {
    return { ok: false, error: '群 id 应以 oc_ 开头(可在群里用机器人或飞书后台获取)' }
  }
  if (input.kind === 'user' && !/^ou_[A-Za-z0-9]+$/.test(id)) {
    return { ok: false, error: '个人 id 应以 ou_ 开头(可先用邮箱解析)' }
  }
  const list = readTargets()
  if (list.some((t) => t.kind === input.kind && t.id === id)) {
    return { ok: false, error: '该目标已存在' }
  }
  if (list.length >= MAX_TARGETS) return { ok: false, error: `最多 ${MAX_TARGETS} 个接收目标` }
  list.push({ kind: input.kind, id, name: (input.name ?? '').trim() || id.slice(0, 10) })
  writeTargets(list)
  return { ok: true, targets: list }
}

export function removeFeishuNotifyTarget(
  kind: 'chat' | 'user',
  id: string
): { ok: boolean; targets?: FeishuNotifyTarget[] } {
  const list = readTargets().filter((t) => !(t.kind === kind && t.id === id))
  writeTargets(list)
  return { ok: true, targets: list }
}

const lastSentAt = new Map<string, number>()

/** 向全部目标发送(带日限额/审计);返回成功条数 */
async function sendToTargets(
  text: string,
  source: string,
  idempotencyKey: string,
  evt?: FeishuNotifyEvent
): Promise<{ sent: number; failed: number; error?: string }> {
  const cfg = getFeishuNotifyConfig()
  if (cfg.targets.length === 0) return { sent: 0, failed: 0, error: '未配置接收目标' }
  if (evt) {
    const last = lastSentAt.get(evt) ?? 0
    if (Date.now() - last < EVENT_MIN_GAP_MS) return { sent: 0, failed: 0 }
    lastSentAt.set(evt, Date.now())
  }
  const remaining = cfg.dailyLimit - countFeishuSentToday()
  if (remaining <= 0) {
    log.warn(`日限额已满(${cfg.dailyLimit}),跳过发送 source=${source}`)
    return { sent: 0, failed: 0, error: '已达每日发送上限' }
  }
  let sent = 0
  let failed = 0
  for (const [idx, t] of cfg.targets.slice(0, remaining).entries()) {
    const r = await sendImText({
      receiveIdType: (t.kind === 'chat' ? 'chat_id' : 'open_id') as FeishuReceiveIdType,
      receiveId: t.id,
      text,
      // 幂等键按「目标序号」区分:同一 uuid 跨不同接收方会被飞书去重,导致后续目标收不到
      idempotencyKey: `${idempotencyKey.slice(0, 24)}-t${idx + 1}`
    })
    insertFeishuSendLog({
      targetKind: t.kind,
      targetId: t.id,
      targetName: t.name,
      content: text,
      source,
      result: r.ok ? 'ok' : 'fail',
      error: r.error,
      messageId: r.messageId
    })
    if (r.ok) sent += 1
    else {
      failed += 1
      log.warn(`发送失败 ${t.kind}:${t.id} ${r.error ?? ''}`)
    }
  }
  return { sent, failed }
}

/** 设置页「发送测试」:只发一条,失败信息直接回显 */
export async function sendFeishuTestMessage(): Promise<{
  ok: boolean
  sent?: number
  error?: string
}> {
  const cfg = getFeishuNotifyConfig()
  if (cfg.targets.length === 0) return { ok: false, error: '请先添加至少一个接收目标(群或个人)' }
  const now = new Date()
  const text = [
    '【测试消息】微信客服工作台 → 飞书通知',
    `时间: ${now.toLocaleString('zh-CN')}`,
    `目标: ${cfg.targets.map((t) => `${t.name}(${t.kind === 'chat' ? '群' : '个人'})`).join('、')}`
  ].join('\n')
  const r = await sendToTargets(text, 'test', `test-${now.getTime()}`)
  if (r.sent === 0) return { ok: false, error: r.error ?? '发送失败(请检查应用可用范围与权限)' }
  return { ok: true, sent: r.sent }
}

export interface AlertIssue {
  id: number
  type: string
  title: string
  severity?: string
  groupName: string
  occurAt: number
  assignee?: string
  reason?: string
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 问题告警推送(新问题 / 盯办升级);未开启或无目标时静默返回 */
export async function notifyIssueAlert(input: {
  kind: FeishuNotifyEvent
  wxid: string
  issues: AlertIssue[]
}): Promise<void> {
  const cfg = getFeishuNotifyConfig()
  if (!cfg.enabled || !cfg.events.includes(input.kind)) return
  if (cfg.targets.length === 0 || input.issues.length === 0) return

  const head =
    input.kind === 'issue_new'
      ? `【新问题】${input.issues.length} 条`
      : `【盯办提醒】${input.issues.length} 条`
  const lines = input.issues.slice(0, 10).map((i, n) => {
    const sev = i.severity && i.severity !== '一般' ? `[${i.severity}] ` : ''
    const who = i.assignee ? ` · 跟进:${i.assignee}` : ' · 未指派'
    const why = i.reason ? ` · ${i.reason}` : ''
    return `${n + 1}. ${sev}${i.type} ${i.title}(群:${i.groupName || '-'}) 首现 ${fmtTime(i.occurAt)}${who}${why}`
  })
  if (input.issues.length > 10) lines.push(`…等共 ${input.issues.length} 条`)
  const text = [head, ...lines, '', '打开微信客服工作台查看详情'].join('\n')

  // 幂等键按「事件+问题集合」派生:同一批问题被重复触发时由飞书侧去重,不重复轰炸
  const key = `${input.kind}-${input.issues
    .slice(0, 6)
    .map((i) => i.id)
    .join('_')}`
  const r = await sendToTargets(text, `notify_${input.kind}`, key, input.kind)
  if (r.sent > 0) log.info(`已推送 ${input.kind} n=${input.issues.length} 目标=${r.sent}`)
}

/** 最近发送记录(设置页展示) */
export function recentFeishuSends(limit = 10): FeishuSendLogRow[] {
  return listFeishuSendLogs(limit)
}
