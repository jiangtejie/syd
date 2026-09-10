import { BrowserWindow } from 'electron'
import {
  analyzeGroupIssues,
  hasGroupWatermark,
  listFeedbackIssues,
  mergeDuplicateIssues,
  reconcileGroupFollowups
} from './analyzer'
import { getSessions } from '../wechat/wxService'
import { getConfig } from '../../db/repos/config'
import { hasDuplicateCandidates, openGroupUsernames } from '../../db/repos/issueRepo'
import { addDbChangeHook, type DbChangedPayload } from '../wechat/watchService'
import { notifyIssueAlert, type AlertIssue } from '../lark/notify'
import { createLogger } from '../logging'

const issueLog = createLogger('issue')

/**
 * 群问题后台调度器（保守档）。
 *
 * 三部分职责：
 * A. 自动增量提取：把「自动」覆盖到全部活跃群——
 *    微信库变化事件(dbChanged) → 立即一轮（15s 冷却）；每 60s 兜底巡检；
 *    无新消息/2 分钟内已尝试 → 内部 skipped 零 LLM；失败不推进水位 → 下轮补读。
 * B. 收尾巡检（每 10 分钟，零 LLM）：对**有 open 问题的群**做规则跟进/收尾判定，
 *    跟进中/待处理/静默收尾/超期搁置都据此刷新——静默收尾的前提是「群里没有新消息」，
 *    搭不上 A 的水位跳过逻辑，所以单独一轮；只在真的发生状态写入时广播刷新。
 *    同一轮顺带做**高置信重复议题自动合并**（issue.autoMergeDuplicates，默认开）：
 *    只有证据几乎完全重合/标题逐字一致这类强信号才自动并，且组内多人跟进时不并；
 *    弱信号一律留给监控页「合并重复」人工预览。
 * C. 盯办升级提醒（issue.escalate.enabled 默认开）：每轮检查正式 open 问题——
 *    未指派超时（紧急 >1h / 其余 >4h，可配）、跟进超时 → cs:issue:changed{escalate}
 *    广播，渲染端失焦时桌面提醒；同一条问题 45 分钟内不重复打扰。
 */
const SWEEP_MS = 60_000
/** 冷启动补扫窗口（自然日）：与工作台默认窗口一致，新群首扫不做全量 7 天 */
const BOOTSTRAP_DAYS = 2
/** 收尾巡检周期（按 tick 计数，60s × 10 = 10 分钟；静默收尾以小时计，无需更密） */
const SETTLE_EVERY_TICKS = 10
const EVENT_MIN_GAP_MS = 15_000
const LLM_PACE_MS = 600
const CACHE_TTL_MS = 5 * 60_000
const CACHE_MIN_AGE_FOR_SESSION_REFRESH_MS = 30_000
const GROUP_NOTIFY_MIN_MS = 20 * 60_000
/** 同一问题的重复提醒间隔梯度：越催越慢，避免同一条问题每 45 分钟轰炸一次 */
const ESCALATE_BACKOFF_MS = [45 * 60_000, 90 * 60_000, 3 * 3600_000, 6 * 3600_000]
/** 提醒记录保留时长：超过即清理（问题闭环后其键不再增长） */
const ESCALATE_KEEP_MS = 24 * 3600_000
const AUTO_SCAN_KEY = 'issue.autoScan.enabled'
/** 高置信重复自动合并开关（issue.autoMergeDuplicates，默认开） */
const AUTO_MERGE_KEY = 'issue.autoMergeDuplicates'
const ESCALATE_KEY = 'issue.escalate.enabled'
const ESCALATE_UNASSIGNED_KEY = 'issue.escalateUnassignedHours'
const ESCALATE_URGENT_KEY = 'issue.escalateUrgentHours'
const ESCALATE_ASSIGNED_KEY = 'issue.escalateAssignedHours'

const timers = new Map<string, ReturnType<typeof setInterval>>()
const runningPass = new Set<string>()
const runningEscalate = new Set<string>()
const runningSettle = new Set<string>()
const tickCount = new Map<string, number>()
/** 冷启动补扫轮转游标（按账号记录上一个补扫的群，下一轮从它之后继续） */
const bootCursor = new Map<string, string>()
const lastPassAt = new Map<string, number>()
const groupNotifiedAt = new Map<string, number>()
const escalateNotifiedAt = new Map<string, { at: number; times: number }>()
const cache = new Map<
  string,
  { at: number; list: Array<{ username: string; displayName: string }> }
>()
/** 事件钩子取消函数:注册后必须能注销,否则 stopAll 后再 ensure 会累积永不清理的回调 */
let uninstallHook: (() => void) | null = null

const enabled = (): boolean => getConfig(AUTO_SCAN_KEY) !== '0'
const autoMergeEnabled = (): boolean => getConfig(AUTO_MERGE_KEY) !== '0'
const escalateEnabled = (): boolean => getConfig(ESCALATE_KEY) !== '0'

function cfgHours(key: string, fallback: number): number {
  const n = Number(getConfig(key))
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

function sendChanged(
  wxid: string,
  extra: { added?: number; escalate?: number; settled?: number }
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('cs:issue:changed', { at: Date.now(), wxid, ...extra })
  }
}

/** 问题对象 → 飞书告警条目(只带必要字段) */
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

/** 新问题 → 飞书推送(开关/节流/限额由 notify 层负责;失败不影响分析主流程) */
function pushNewIssueAlert(wxid: string, groupUsername: string, count: number): void {
  try {
    const items = listFeedbackIssues(wxid)
      .filter((i) => i.groupUsername === groupUsername && i.status === 'open')
      .sort((a, b) => b.occurAt - a.occurAt)
      .slice(0, Math.min(Math.max(count, 1), 10))
      .map(toAlertIssue)
    if (items.length === 0) return
    void notifyIssueAlert({ kind: 'issue_new', wxid, issues: items })
  } catch (e) {
    issueLog.warn(`飞书推送(新问题)失败 ${wxid}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * 「发现问题」统一出口：广播 + 飞书推送（按群 20 分钟节流，避免多轮巡检重复打扰）。
 * 增量提取与冷启动补扫共用，保证「新群首扫发现问题」也有提示音/桌面提醒。
 */
function notifyGroupNew(wxid: string, groupUsername: string, count: number): void {
  const k = `${wxid}|${groupUsername}`
  const last = groupNotifiedAt.get(k)
  const now = Date.now()
  if (last && now - last < GROUP_NOTIFY_MIN_MS) return
  groupNotifiedAt.set(k, now)
  sendChanged(wxid, { added: count })
  pushNewIssueAlert(wxid, groupUsername, count)
}

/** 候选群（近 7 天活跃、非企微、有展示名），按最后消息倒序取前 30；读取失败返回空并触发下轮重试 */
function listCandidates(wxid: string): Array<{ username: string; displayName: string }> {
  const hit = cache.get(wxid)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.list
  const sessionsRes = getSessions(wxid)
  if (!sessionsRes.ok || !sessionsRes.sessions) return []
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const windowStart = today.getTime() - 6 * 24 * 3600_000
  const list = sessionsRes.sessions
    .filter(
      (s) =>
        s.isGroup && !s.isWeCom && s.lastTimestamp >= windowStart && s.displayName.trim() !== ''
    )
    .sort((a, b) => b.lastTimestamp - a.lastTimestamp)
    .slice(0, 30)
    .map((g) => ({ username: g.username, displayName: g.displayName }))
  cache.set(wxid, { at: Date.now(), list })
  return list
}

async function runPass(wxid: string): Promise<void> {
  if (runningPass.has(wxid) || !enabled()) return
  runningPass.add(wxid)
  lastPassAt.set(wxid, Date.now())
  let added = 0
  let llmGroups = 0
  try {
    const groups = listCandidates(wxid)
    // 冷启动补扫：从未分析过的群（无水位）以前在后台被永久跳过 —— 用户不打开群问题面板就永远提取不到。
    // 每轮只补一个群并按活跃度顺序轮转：额度可控（每分钟最多 1 个群），失败的群也不会卡住其他群。
    const fresh = groups.filter((g) => !hasGroupWatermark(wxid, g.username))
    let bootstrapped: string | null = null
    if (fresh.length > 0) {
      const cursor = bootCursor.get(wxid)
      const at = cursor ? fresh.findIndex((g) => g.username === cursor) : -1
      const target = fresh[(at + 1) % fresh.length]
      bootstrapped = target.username
      bootCursor.set(wxid, target.username)
      const rb = await analyzeGroupIssues(wxid, target.username, target.displayName, {
        days: BOOTSTRAP_DAYS
      }).catch((e: unknown) => {
        issueLog.error(`冷启动补扫失败 ${wxid} ${target.displayName}`, e)
        return null
      })
      if (rb && rb.ok && !rb.skipped) {
        if (rb.count && rb.count > 0) {
          added += rb.count
          notifyGroupNew(wxid, target.username, rb.count)
        }
        if (rb.method === 'llm') {
          llmGroups += 1
          await new Promise((res) => setTimeout(res, LLM_PACE_MS))
        }
        issueLog.debug(`冷启动补扫 ${wxid} ${target.displayName} 剩余 ${fresh.length - 1} 个新群`)
      }
    }
    for (const g of groups) {
      // 尚无水位的群本轮若未轮到补扫（每轮一个），跳过；本轮刚补扫过的群不再重复跑增量
      if (g.username === bootstrapped) continue
      if (!hasGroupWatermark(wxid, g.username)) continue
      const r = await analyzeGroupIssues(wxid, g.username, g.displayName).catch((e: unknown) => {
        issueLog.error(`增量分析失败 ${wxid} ${g.displayName}`, e)
        return null
      })
      if (r && r.ok && !r.skipped && r.count && r.count > 0) {
        added += r.count
        notifyGroupNew(wxid, g.username, r.count)
      }
      if (r && r.ok && !r.skipped && r.method === 'llm') {
        llmGroups += 1
        await new Promise((res) => setTimeout(res, LLM_PACE_MS))
      }
    }
    if (groups.length > 0) {
      issueLog.debug(`增量巡检 ${wxid} groups=${groups.length} added=${added} llm=${llmGroups}`)
    }
  } finally {
    runningPass.delete(wxid)
  }
}

function onDbChanged(payload: DbChangedPayload): void {
  if (!timers.has(payload.wxid)) return
  if (payload.info.sessionChanged) {
    const hit = cache.get(payload.wxid)
    if (!hit || Date.now() - hit.at >= CACHE_MIN_AGE_FOR_SESSION_REFRESH_MS) {
      cache.delete(payload.wxid)
    }
  }
  const last = lastPassAt.get(payload.wxid) ?? 0
  if (Date.now() - last >= EVENT_MIN_GAP_MS) void runPass(payload.wxid)
}

/**
 * 收尾巡检：对仍有 open 问题的群做规则判定（跟进中/待处理 → 静默收尾 → 超期搁置）。
 * 只读消息、零 LLM；仅在发生状态写入时广播，避免每 10 分钟无谓刷新渲染端。
 */
async function runSettle(wxid: string): Promise<void> {
  if (runningSettle.has(wxid) || !enabled()) return
  runningSettle.add(wxid)
  try {
    // 只取「有 open 问题的群名」（一条 DISTINCT 查询），不必把全部历史问题拉出来装饰一遍
    const groups = new Set(openGroupUsernames(wxid))
    if (groups.size === 0) return
    let changed = 0
    for (const g of groups) {
      try {
        changed += reconcileGroupFollowups(wxid, g).changed
      } catch (e) {
        issueLog.warn(`收尾巡检失败 ${wxid} ${g}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    // 高置信重复议题自动合并（零 LLM，纯判据；弱信号不碰）
    // 前置：没有「同群 ≥2 条 open」就跳过聚类，避免每 10 分钟做无用功
    if (autoMergeEnabled() && hasDuplicateCandidates(wxid)) {
      try {
        const m = mergeDuplicateIssues(wxid, { strongOnly: true })
        if (m.merged > 0) {
          changed += m.merged
          issueLog.info(
            `自动合并重复议题 ${wxid} 组=${m.clusters} 归档=${m.merged} ` +
              `明细=${m.plan.map((x) => `${x.keepId}<-${x.dropIds.join('+')}`).join(',')}`
          )
        }
      } catch (e) {
        issueLog.warn(`自动合并重复议题失败 ${wxid}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (changed > 0) {
      sendChanged(wxid, { settled: changed })
      issueLog.debug(`收尾巡检 ${wxid} groups=${groups.size} changed=${changed}`)
    }
  } finally {
    runningSettle.delete(wxid)
  }
}

/** 账号接入后启动：注册事件钩子（全局一次）+ 每 60s 巡检 + 立即一轮 */
export function ensure(wxid: string): void {
  if (!wxid || timers.has(wxid)) return
  if (!uninstallHook) {
    uninstallHook = addDbChangeHook(onDbChanged)
  }
  const tick = (): void => {
    void runPass(wxid)
    void runEscalate(wxid)
    const n = (tickCount.get(wxid) ?? 0) + 1
    tickCount.set(wxid, n)
    if (n % SETTLE_EVERY_TICKS === 0) void runSettle(wxid)
  }
  timers.set(wxid, setInterval(tick, SWEEP_MS))
  void runPass(wxid)
  void runEscalate(wxid)
}

/**
 * 盯办升级：检查正式 open 问题（排除疑似）——
 * 未指派超阈值（紧急 > issue.escalateUrgentHours 默认1h / 其他 > issue.escalateUnassignedHours 默认4h）、
 * 已指派但长期没闭环（> issue.escalateAssignedHours 默认8h）、跟进超时
 * （monitor.followUpHours 已由 listIssues 计算 followUpOverdue）。
 * 命中且超过该问题的退避间隔（45min → 90min → 3h → 6h）即广播 escalate（渲染端未聚焦时桌面提醒）。
 */
async function runEscalate(wxid: string): Promise<void> {
  if (!timers.has(wxid) || !escalateEnabled()) return
  if (runningEscalate.has(wxid)) return
  runningEscalate.add(wxid)
  try {
    const now = Date.now()
    const unassignedMs = cfgHours(ESCALATE_UNASSIGNED_KEY, 4) * 3600_000
    const urgentMs = cfgHours(ESCALATE_URGENT_KEY, 1) * 3600_000
    const assignedMs = cfgHours(ESCALATE_ASSIGNED_KEY, 8) * 3600_000
    // 清理过期提醒记录（问题闭环后其键不再增长；量小，每轮顺带扫一遍）
    for (const [k, v] of escalateNotifiedAt) {
      if (now - v.at > ESCALATE_KEEP_MS) escalateNotifiedAt.delete(k)
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
        // 指派了也要盯：指派后长期**没有人回复过**（客户在等）同样要升级。
        // 已回复的走「跟进超时」，避免正在等客户确认的议题被重复催办。
        reason = '已指派未处理'
      }
      if (!reason && i.followUpOverdue) reason = '跟进超时'
      if (!reason) continue
      // 退避：同一条问题第 n 次提醒的间隔递增（45min → 90min → 3h → 6h）
      const key = `${wxid}|${i.id}|${reason}`
      const hit = escalateNotifiedAt.get(key)
      const wait = ESCALATE_BACKOFF_MS[Math.min(hit?.times ?? 0, ESCALATE_BACKOFF_MS.length - 1)]
      if (!hit || now - hit.at >= wait) {
        escalateNotifiedAt.set(key, { at: now, times: (hit?.times ?? 0) + 1 })
        fresh.push({ id: i.id, reason })
      }
    }
    if (fresh.length > 0) {
      sendChanged(wxid, { escalate: fresh.length })
      issueLog.info(`盯办升级 ${wxid} n=${fresh.length} items=${fresh.map((f) => f.id).join(',')}`)
      try {
        const byId = new Map(all.map((i) => [i.id, i]))
        const alertItems: AlertIssue[] = []
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
    runningEscalate.delete(wxid)
  }
}

/** 应用退出时全部停止 */
export function stopAll(): void {
  for (const t of timers.values()) clearInterval(t)
  timers.clear()
  runningPass.clear()
  runningEscalate.clear()
  runningSettle.clear()
  tickCount.clear()
  bootCursor.clear()
  cache.clear()
  lastPassAt.clear()
  groupNotifiedAt.clear()
  escalateNotifiedAt.clear()
  uninstallHook?.()
  uninstallHook = null
}
