import { getConfig, getConfigBoolean, setConfig } from '../../db/repos/config'
import { listIssues } from '../../db/repos/issueRepo'
import { listTeamMembers } from '../../db/repos/teamRepo'
import { replyStats } from '../../db/repos/agentReplyRepo'
import { getFeishuNotifyConfig, sendDigestText } from '../lark/notify'
import { ageText, renderDigest, type DigestData, type DigestItem } from './digestText'
import { createLogger } from '../logging'
import type { FeedbackIssue } from '../../../shared/types'

const digestLog = createLogger('issue')

/**
 * 每日日报：把「昨天发生了什么 + 现在卡在哪」推到飞书群，让不在电脑前的人也能看到。
 *
 * 三个设计取舍：
 * 1. **不受告警开关影响**：日报有自己的开关（有人只想要日报、不要实时告警），但共用接收目标与日限额；
 * 2. **幂等按天**：`lark.digest.lastDate` 记住已发日期，重启/多轮 tick 都不会重复发；
 * 3. **空也发**：没有待办也发一句「今天没有待处理问题 ✓」—— 定时任务静默死掉是最难发现的事故。
 */

export const CFG_DIGEST_ENABLED = 'lark.digest.enabled'
export const CFG_DIGEST_TIME = 'lark.digest.time'
export const CFG_DIGEST_LAST_DATE = 'lark.digest.lastDate'
export const CFG_DIGEST_AGENT = 'lark.digest.includeAgent'

const DEFAULT_TIME = '09:00'
/** 日报里最多列几条（手机上要一眼看完） */
const TOP_N = 3

export interface DigestConfig {
  enabled: boolean
  /** HH:mm */
  time: string
  includeAgent: boolean
  /** 上次成功发送的日期（YYYY-MM-DD） */
  lastDate: string
  /** 接收目标数（复用飞书通知的目标；为 0 时发不出去） */
  targets: number
}

export function digestTimeValid(t: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test((t || '').trim())
}

export function getDigestConfig(): DigestConfig {
  const time = (getConfig(CFG_DIGEST_TIME) ?? '').trim() || DEFAULT_TIME
  return {
    enabled: getConfigBoolean(CFG_DIGEST_ENABLED, false),
    time: digestTimeValid(time) ? time : DEFAULT_TIME,
    includeAgent: getConfigBoolean(CFG_DIGEST_AGENT, true),
    lastDate: (getConfig(CFG_DIGEST_LAST_DATE) ?? '').trim(),
    targets: getFeishuNotifyConfig().targets.length
  }
}

export function setDigestConfig(patch: {
  enabled?: boolean
  time?: string
  includeAgent?: boolean
}): { ok: boolean; error?: string; config: DigestConfig } {
  if (patch.time !== undefined) {
    const t = (patch.time || '').trim()
    if (!digestTimeValid(t))
      return { ok: false, error: '时间格式应为 HH:mm（如 09:00）', config: getDigestConfig() }
    setConfig(CFG_DIGEST_TIME, t)
  }
  if (patch.enabled !== undefined) setConfig(CFG_DIGEST_ENABLED, patch.enabled ? '1' : '0')
  if (patch.includeAgent !== undefined) setConfig(CFG_DIGEST_AGENT, patch.includeAgent ? '1' : '0')
  return { ok: true, config: getDigestConfig() }
}

function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function dateKey(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function label(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function toItem(i: FeedbackIssue, names: Map<string, string>, now: number): DigestItem {
  return {
    group: i.groupName || i.groupUsername,
    type: i.type,
    title: (i.title ?? '').slice(0, 30),
    ageText: ageText(now - i.occurAt),
    assignee: i.assignee ? names.get(i.assignee) || i.assignee : undefined
  }
}

/** 汇总成日报数据（纯读库，不发消息；预览与定时发送共用同一份口径） */
export function collectDigestData(wxid: string, now = Date.now()): DigestData {
  const issues = listIssues(wxid)
  const today0 = startOfDay(now)
  const yStart = today0 - 86_400_000
  const names = new Map(listTeamMembers(wxid).map((m) => [m.username, m.label || m.username]))

  const created = issues.filter((i) => i.createdAt >= yStart && i.createdAt < today0).length
  const resolved = issues.filter(
    (i) => !!i.resolvedAt && i.resolvedAt >= yStart && i.resolvedAt < today0
  ).length
  const openList = issues.filter((i) => i.status === 'open' && !i.needConfirm)
  const noReplyList = openList.filter((i) => !i.followUp)
  const following = openList.filter((i) => i.followUp && !i.followUpOverdue).length
  const overdue = openList.filter((i) => i.followUpOverdue).length
  const doubt = issues.filter((i) => i.status === 'open' && i.needConfirm).length

  // 积压最久 / 无人应：都按首现时间升序取前 N（最早的最急）
  const byOldest = [...openList].sort((a, b) => a.occurAt - b.occurAt).slice(0, TOP_N)
  const waiting = [...noReplyList].sort((a, b) => a.occurAt - b.occurAt).slice(0, TOP_N)

  const perOwner = new Map<string, number>()
  for (const i of openList) {
    if (!i.assignee) continue
    const n = names.get(i.assignee) || i.assignee
    perOwner.set(n, (perOwner.get(n) ?? 0) + 1)
  }
  const topAssignees = [...perOwner.entries()]
    .map(([name, open]) => ({ name, open }))
    .sort((a, b) => b.open - a.open)
    .slice(0, 4)

  const cfg = getDigestConfig()
  let agent: DigestData['agent'] = null
  if (cfg.includeAgent) {
    const s = replyStats(wxid, yStart)
    if (s.total > 0) {
      agent = {
        total: s.total,
        script: s.script,
        llm: s.llm,
        handoff: s.handoff,
        coverage: 1 - s.noMatchRate
      }
    }
  }

  return {
    dateLabel: label(now),
    created,
    resolved,
    open: openList.length,
    noReply: noReplyList.length,
    following,
    overdue,
    doubt,
    topBacklog: byOldest.map((i) => toItem(i, names, now)),
    waiting: waiting.map((i) => toItem(i, names, now)),
    topAssignees,
    agent
  }
}

/** 立即发送一条（手动「立即发送」与定时共用）；返回文案便于设置页预览 */
export async function sendDigestNow(
  wxid: string,
  opts: { now?: number; markSent?: boolean } = {}
): Promise<{ ok: boolean; sent: number; error?: string; text: string }> {
  const now = opts.now ?? Date.now()
  const text = renderDigest(collectDigestData(wxid, now))
  const r = await sendDigestText(text, `digest-${dateKey(now)}`)
  if (r.ok && opts.markSent !== false) setConfig(CFG_DIGEST_LAST_DATE, dateKey(now))
  return { ok: r.ok, sent: r.sent, error: r.error, text }
}

/**
 * 到点就发（挂在既有 60s tick 上）：同一天只发一次。
 * 返回 true 表示本次真的发了。
 */
export async function maybeSendDailyDigest(wxid: string, now = Date.now()): Promise<boolean> {
  const cfg = getDigestConfig()
  if (!cfg.enabled) return false
  if (cfg.lastDate === dateKey(now)) return false
  const [hh, mm] = cfg.time.split(':').map((x) => Number.parseInt(x, 10))
  const d = new Date(now)
  if (d.getHours() * 60 + d.getMinutes() < hh * 60 + mm) return false
  const r = await sendDigestNow(wxid, { now })
  if (!r.ok) {
    digestLog.warn(`日报发送失败: ${r.error ?? '未知原因'}`)
    return false
  }
  digestLog.info(`日报已推送（目标 ${r.sent} 个）`)
  return true
}
