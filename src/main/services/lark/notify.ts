import { getConfig, getConfigBoolean, getConfigNumber, setConfig } from '../../db/repos/config'
import {
  countFeishuSentToday,
  insertFeishuSendLog,
  listFeishuSendLogs,
  type FeishuSendLogRow
} from '../../db/repos/feishuSendLogRepo'
import { createLogger } from '../logging'
import { sendImText, type FeishuReceiveIdType } from './im'
import { fmtStamp, fmtTimeShort } from '../../../shared/monitorMetrics'
import { listIssuesByGroup } from '../../db/repos/issueRepo'
import { buildGroupIssuesText } from './issueDigest'
import { openIdOf } from './personMap'
import { atTag } from '../im/mention'
import { APP_NAME } from '../../../shared/appInfo'

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

export type FeishuNotifyEvent = 'issue_new' | 'issue_escalate' | 'issue_digest'

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
  if (raw.includes('issue_digest')) out.push('issue_digest')
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
  return dispatchTo(cfg.targets.slice(0, remaining), text, source, idempotencyKey)
}

/**
 * 逐个目标发送并写审计（限额与节流由调用方判定）。
 * 幂等键按「目标序号」区分：同一 uuid 跨不同接收方会被飞书去重，导致后续目标收不到。
 */
async function dispatchTo(
  targets: FeishuNotifyTarget[],
  text: string,
  source: string,
  idempotencyKey: string
): Promise<{ sent: number; failed: number }> {
  let sent = 0
  let failed = 0
  for (const [idx, t] of targets.entries()) {
    const r = await sendImText({
      receiveIdType: (t.kind === 'chat' ? 'chat_id' : 'open_id') as FeishuReceiveIdType,
      receiveId: t.id,
      text,
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
    '【测试消息】' + APP_NAME + ' → 飞书通知',
    `时间: ${fmtStamp(now.getTime())}`,
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
    // 跟进人已知 open_id 就 @ 到他（飞书文本的 @ 是内容里的标签，见 im/mention.ts）
    const who = i.assignee
      ? ` · 跟进:${atTag(openIdOf(i.assignee), i.assignee) || i.assignee}`
      : ' · 未指派'
    const why = i.reason ? ` · ${i.reason}` : ''
    return `${n + 1}. ${sev}${i.type} ${i.title}(群:${i.groupName || '-'}) 首现 ${fmtStamp(i.occurAt)}${who}${why}`
  })
  if (input.issues.length > 10) lines.push(`…等共 ${input.issues.length} 条`)
  const text = [head, ...lines, '', '打开「' + APP_NAME + '」查看详情'].join('\n')

  // 幂等键按「事件+时间片+问题集合」派生:同一批问题的重复触发仍由飞书侧去重(不重复轰炸),
  // 但跨时间片的再次提醒必须发得出去——纯按问题 id 派生时,45 分钟后的再次提醒会带着同一个 uuid,
  // 被飞书当成重复消息静默丢弃(调度器侧的退避就白设了)。时间片取 45 分钟,与盯办首个退避档对齐。
  const bucket = Math.floor(Date.now() / (45 * 60_000))
  const key = `${input.kind}-${bucket}-${input.issues
    .slice(0, 6)
    .map((i) => i.id)
    .join('_')}`
  const r = await sendToTargets(text, `notify_${input.kind}`, key, input.kind)
  if (r.sent > 0) log.info(`已推送 ${input.kind} n=${input.issues.length} 目标=${r.sent}`)
}

/**
 * 发送日报（每日定时推送用）。
 * 与告警不同：日报有**自己的开关**（lark.digest.enabled），不受 feishu.notify.enabled / events 影响 ——
 * 有人只想要每天一份日报、不要实时告警；但接收目标、日限额与审计是共用的。
 */
export async function sendDigestText(
  text: string,
  idempotencyKey: string
): Promise<{ ok: boolean; sent: number; error?: string }> {
  const r = await sendToTargets(text, 'digest', idempotencyKey)
  if (r.sent > 0) log.info(`已推送日报 目标=${r.sent}`)
  if (r.sent === 0)
    return { ok: false, sent: 0, error: r.error ?? '发送失败(请检查接收目标与权限)' }
  return { ok: true, sent: r.sent }
}

/** 最近发送记录(设置页展示) */
export function recentFeishuSends(limit = 10): FeishuSendLogRow[] {
  return listFeishuSendLogs(limit)
}

/* ── 主动发送（工作台「发到飞书」按钮 + AI 工具 feishu_send_message）── */

export interface FeishuSendNowResult {
  ok: boolean
  sent: number
  failed: number
  /** 实际发送到的目标展示名（便于 UI/模型回话） */
  targets: string[]
  error?: string
}

/**
 * 主动发送一条文本（带日限额与审计）。
 * 与告警推送的区别：**不按事件节流**、可指定目标（不指定则发给全部目标）。
 * 目标只能从「设置 → IM 渠道 → 飞书通知」里已配置的接收目标中选，模型/UI 无法凭空指定 receive_id。
 */
export async function sendFeishuTextNow(input: {
  text: string
  targetName?: string
  source: string
  idempotencyKey?: string
}): Promise<FeishuSendNowResult> {
  const cfg = getFeishuNotifyConfig()
  if (cfg.targets.length === 0) {
    return {
      ok: false,
      sent: 0,
      failed: 0,
      targets: [],
      error: '未配置飞书接收目标：请到 设置 → IM 渠道 → 飞书通知 添加'
    }
  }
  const wanted = (input.targetName ?? '').trim()
  let picked = cfg.targets
  if (wanted) {
    picked = cfg.targets.filter((t) => t.name === wanted || t.id === wanted)
    if (picked.length === 0) {
      const names = cfg.targets
        .map((t) => `${t.name}(${t.kind === 'chat' ? '群' : '个人'})`)
        .join('、')
      return {
        ok: false,
        sent: 0,
        failed: 0,
        targets: [],
        error: `找不到目标「${wanted}」；现有目标：${names}`
      }
    }
  }
  const remaining = cfg.dailyLimit - countFeishuSentToday()
  if (remaining <= 0)
    return { ok: false, sent: 0, failed: 0, targets: [], error: '已达每日发送上限' }
  const text = (input.text ?? '').trim()
  if (!text) return { ok: false, sent: 0, failed: 0, targets: [], error: '内容为空' }
  const key = (input.idempotencyKey ?? `now-${Date.now()}`).slice(0, 40)
  const r = await dispatchTo(picked.slice(0, remaining), text, input.source, key)
  const names = picked.slice(0, remaining).map((t) => t.name || t.id)
  if (r.sent === 0) {
    return {
      ok: false,
      sent: 0,
      failed: r.failed,
      targets: names,
      error: '发送失败（请检查应用可用范围与权限）'
    }
  }
  return { ok: true, sent: r.sent, failed: r.failed, targets: names }
}

/**
 * 把某个群的「未闭环问题」摘要发到飞书（工作台群问题面板的「发到飞书」按钮）。
 * 摘要文案由 lib 无关的纯函数 buildGroupIssuesText 生成，AI 工具与 UI 共用同一口径。
 */
export async function sendFeishuGroupIssues(input: {
  wxid: string
  chatroom: string
  targetName?: string
  limit?: number
}): Promise<FeishuSendNowResult & { count: number }> {
  const now = Date.now()
  const issues = listIssuesByGroup(input.wxid, input.chatroom)
  const open = issues.filter((i) => i.status === 'open' || i.status === 'stalled')
  const groupName = issues[0]?.groupName ?? ''
  // 时间文案在这里用共享实现算好（issueDigest 是零依赖纯函数，见其文件头说明）
  const text = buildGroupIssuesText({
    groupName,
    nowText: fmtStamp(now),
    limit: input.limit ?? 8,
    issues: issues.map((i) => ({
      id: i.id,
      title: i.title,
      type: i.type,
      status: i.status,
      severity: i.severity,
      occurText: fmtTimeShort(i.occurAt),
      followUp: i.followUp,
      followUpOverdue: i.followUpOverdue,
      assignee: i.assignee
    }))
  })
  const r = await sendFeishuTextNow({
    text,
    targetName: input.targetName,
    source: 'group_issues',
    idempotencyKey: `gip-${input.chatroom}-${Date.now()}`
  })
  return { ...r, count: open.length }
}
