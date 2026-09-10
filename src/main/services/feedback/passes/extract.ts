import { analyzeGroupIssues, hasGroupWatermark, listFeedbackIssues } from '../analyzer'
import { notifyIssueAlert, type AlertIssue } from '../../lark/notify'
import { getSessions } from '../../wechat/wxService'
import { skipAutoAnalysis } from '../groupScope'
import { autoScanEnabled, issueLog, sendChanged, sleep } from './shared'

/**
 * 通道 A：自动增量提取。
 *
 * - 触发：微信群库变化事件（15s 冷却）+ 入口每 60s 兜底巡检 + 账号接入时立即一轮；
 * - 范围：近 7 天活跃、非企微、有展示名的群，按活跃度排序取前 30；
 * - 增量语义：无新消息 / 2 分钟内已尝试 → analyzeGroupIssues 内部直接 skipped（零 LLM）；
 *   失败不推进水位，下一轮自然补读；
 * - 冷启动补扫：从未分析过的群（无水位）在后台以前是永久跳过（用户不打开群问题面板就永远提取不到），
 *   现在每轮补 1 个并按活跃度轮转 —— 额度可控（每分钟最多 1 个群），失败的群也不会卡住其他群。
 */

/** 事件驱动的冷却：微信库变化很频繁，太密只是白跑 */
const EVENT_MIN_GAP_MS = 15_000
/** 群候选缓存 TTL（会话列表读取要开联系人库，别每次巡检都读） */
const CACHE_TTL_MS = 5 * 60_000
/** 会话变化后允许刷新缓存的最小间隔（避免抖动时反复失效） */
const CACHE_MIN_AGE_FOR_SESSION_REFRESH_MS = 30_000
/** 每群「发现问题」提醒节流：同一群 20 分钟内只提醒一次 */
const GROUP_NOTIFY_MIN_MS = 20 * 60_000
/** 群之间给 LLM 通道留的节奏间隔 */
const LLM_PACE_MS = 600
/** 冷启动补扫窗口（自然日）：与工作台默认窗口一致，新群首扫不做全量 7 天 */
const BOOTSTRAP_DAYS = 2

const running = new Set<string>()
const lastPassAt = new Map<string, number>()
const groupNotifiedAt = new Map<string, number>()
const bootCursor = new Map<string, string>()
const cache = new Map<
  string,
  { at: number; list: Array<{ username: string; displayName: string }> }
>()

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

/** 新问题 → 飞书推送（开关/节流/限额由 notify 层负责；失败不影响分析主流程） */
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

/** 会话列表变化：失效候选缓存（抖动期内不反复失效） */
export function invalidateCandidates(wxid: string): void {
  const hit = cache.get(wxid)
  if (!hit || Date.now() - hit.at >= CACHE_MIN_AGE_FOR_SESSION_REFRESH_MS) cache.delete(wxid)
}

/** 一轮增量提取（含冷启动补扫一个群） */
export async function runExtractPass(wxid: string): Promise<void> {
  if (running.has(wxid) || !autoScanEnabled()) return
  running.add(wxid)
  lastPassAt.set(wxid, Date.now())
  let added = 0
  let llmGroups = 0
  try {
    // 群级参与开关：被排除的群（采购/供应链/内部群）不参与任何自动分析
    const groups = listCandidates(wxid).filter((g) => !skipAutoAnalysis(wxid, g.username))
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
          await sleep(LLM_PACE_MS)
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
        await sleep(LLM_PACE_MS)
      }
    }
    if (groups.length > 0) {
      issueLog.debug(`增量巡检 ${wxid} groups=${groups.length} added=${added} llm=${llmGroups}`)
    }
  } finally {
    running.delete(wxid)
  }
}

/** 事件驱动入口（含 15s 冷却）：由入口的库变更钩子调用 */
export function runExtractOnDbEvent(wxid: string): void {
  const last = lastPassAt.get(wxid) ?? 0
  if (Date.now() - last >= EVENT_MIN_GAP_MS) void runExtractPass(wxid)
}

/** 停止调度时清空进程内状态（避免 stopAll 后再 ensure 累积旧数据） */
export function resetExtractState(): void {
  running.clear()
  lastPassAt.clear()
  groupNotifiedAt.clear()
  bootCursor.clear()
  cache.clear()
}
