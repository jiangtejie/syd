import { BrowserWindow } from 'electron'
import { analyzeGroupIssues, hasGroupWatermark, listFeedbackIssues } from './analyzer'
import { getSessions } from '../wechat/wxService'
import { getConfig } from '../../db/repos/config'
import { addDbChangeHook, type DbChangedPayload } from '../wechat/watchService'
import { createLogger } from '../logging'

const issueLog = createLogger('issue')

/**
 * 群问题后台调度器（保守档）。
 *
 * 两部分职责：
 * A. 自动增量提取：把「自动」覆盖到全部活跃群——
 *    微信库变化事件(dbChanged) → 立即一轮（15s 冷却）；每 60s 兜底巡检；
 *    无新消息/2 分钟内已尝试 → 内部 skipped 零 LLM；失败不推进水位 → 下轮补读。
 * B. 盯办升级提醒（issue.escalate.enabled 默认开）：每轮检查正式 open 问题——
 *    未指派超时（紧急 >1h / 其余 >4h，可配）、跟进超时 → cs:issue:changed{escalate}
 *    广播，渲染端失焦时桌面提醒；同一条问题 45 分钟内不重复打扰。
 */
const SWEEP_MS = 60_000
const EVENT_MIN_GAP_MS = 15_000
const LLM_PACE_MS = 600
const CACHE_TTL_MS = 5 * 60_000
const CACHE_MIN_AGE_FOR_SESSION_REFRESH_MS = 30_000
const GROUP_NOTIFY_MIN_MS = 20 * 60_000
const AUTO_SCAN_KEY = 'issue.autoScan.enabled'
const ESCALATE_KEY = 'issue.escalate.enabled'
const ESCALATE_UNASSIGNED_KEY = 'issue.escalateUnassignedHours'
const ESCALATE_URGENT_KEY = 'issue.escalateUrgentHours'
const ESCALATE_ITEM_MIN_MS = 45 * 60_000

const timers = new Map<string, ReturnType<typeof setInterval>>()
const runningPass = new Set<string>()
const runningEscalate = new Set<string>()
const lastPassAt = new Map<string, number>()
const groupNotifiedAt = new Map<string, number>()
const escalateNotifiedAt = new Map<string, number>()
const cache = new Map<
  string,
  { at: number; list: Array<{ username: string; displayName: string }> }
>()
/** 事件钩子取消函数:注册后必须能注销,否则 stopAll 后再 ensure 会累积永不清理的回调 */
let uninstallHook: (() => void) | null = null

const enabled = (): boolean => getConfig(AUTO_SCAN_KEY) !== '0'
const escalateEnabled = (): boolean => getConfig(ESCALATE_KEY) !== '0'

function cfgHours(key: string, fallback: number): number {
  const n = Number(getConfig(key))
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

function sendChanged(wxid: string, extra: { added?: number; escalate?: number }): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('cs:issue:changed', { at: Date.now(), wxid, ...extra })
  }
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
    for (const g of groups) {
      // 冷启动保护：尚无水位的群跳过（首次全量由打开群/手动分析触发），后台只做增量
      if (!hasGroupWatermark(wxid, g.username)) continue
      const r = await analyzeGroupIssues(wxid, g.username, g.displayName).catch((e: unknown) => {
        issueLog.error(`增量分析失败 ${wxid} ${g.displayName}`, e)
        return null
      })
      if (r && r.ok && !r.skipped && r.count && r.count > 0) {
        added += r.count
        const k = `${wxid}|${g.username}`
        const last = groupNotifiedAt.get(k)
        const now = Date.now()
        if (!last || now - last >= GROUP_NOTIFY_MIN_MS) {
          groupNotifiedAt.set(k, now)
          sendChanged(wxid, { added: r.count })
        }
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

/** 账号接入后启动：注册事件钩子（全局一次）+ 每 60s 巡检 + 立即一轮 */
export function ensure(wxid: string): void {
  if (!wxid || timers.has(wxid)) return
  if (!uninstallHook) {
    uninstallHook = addDbChangeHook(onDbChanged)
  }
  const tick = (): void => {
    void runPass(wxid)
    void runEscalate(wxid)
  }
  timers.set(wxid, setInterval(tick, SWEEP_MS))
  void runPass(wxid)
  void runEscalate(wxid)
}

/**
 * 盯办升级：检查正式 open 问题（排除疑似）——
 * 未指派超阈值（紧急 > issue.escalateUrgentHours 默认1h / 其他 > issue.escalateUnassignedHours 默认4h）
 * 或跟进超时（monitor.followUpHours 已由 listIssues 计算 followUpOverdue）。
 * 命中且 45 分钟内未提醒过 → 广播 escalate（渲染端未聚焦时桌面提醒）。
 */
async function runEscalate(wxid: string): Promise<void> {
  if (!timers.has(wxid) || !escalateEnabled()) return
  if (runningEscalate.has(wxid)) return
  runningEscalate.add(wxid)
  try {
    const now = Date.now()
    const unassignedMs = cfgHours(ESCALATE_UNASSIGNED_KEY, 4) * 3600_000
    const urgentMs = cfgHours(ESCALATE_URGENT_KEY, 1) * 3600_000
    const items = listFeedbackIssues(wxid).filter((i) => i.status === 'open' && !i.needConfirm)
    const fresh: Array<{ id: number; reason: string }> = []
    for (const i of items) {
      let reason = ''
      const age = now - i.occurAt
      if (!i.assignee) {
        const t = i.severity === '紧急' ? urgentMs : unassignedMs
        if (age >= t) reason = i.severity === '紧急' ? '紧急问题未指派' : '问题未指派'
      }
      if (!reason && i.followUpOverdue) reason = '跟进超时'
      if (!reason) continue
      const key = `${wxid}|${i.id}|${reason}`
      const last = escalateNotifiedAt.get(key)
      if (!last || now - last >= ESCALATE_ITEM_MIN_MS) {
        escalateNotifiedAt.set(key, now)
        fresh.push({ id: i.id, reason })
      }
    }
    if (fresh.length > 0) {
      sendChanged(wxid, { escalate: fresh.length })
      issueLog.info(`盯办升级 ${wxid} n=${fresh.length} items=${fresh.map((f) => f.id).join(',')}`)
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
  cache.clear()
  lastPassAt.clear()
  groupNotifiedAt.clear()
  escalateNotifiedAt.clear()
  uninstallHook?.()
  uninstallHook = null
}
