import { BrowserWindow } from 'electron'
import { analyzeGroupIssues, hasGroupWatermark } from './analyzer'
import { getSessions } from '../wechat/wxService'
import { getConfig } from '../../db/repos/config'
import { addDbChangeHook, type DbChangedPayload } from '../wechat/watchService'

/**
 * 群问题后台增量调度器（保守档）。
 *
 * 补齐现状缺口：新消息到达时只有「当前打开的群」会自动增量分析，其余活跃群要等人点开或手动全量。
 * 本调度器把「自动提取」覆盖到全部活跃群：
 * - 触发：微信库变化事件(dbChanged) → 立即一轮（同账号 15s 冷却防风暴）；每 60s 兜底巡检一轮（防丢事件）；
 * - 每轮：按活跃度取近 7 天候选群（缓存 5 分钟，会话库变化即失效），逐个走 analyzeGroupIssues 增量：
 *   群内无新消息 / 2 分钟内已尝试 → 内部 skipped，零 LLM 成本；失败不推进水位 → 下一轮自然补读重试；
 * - 节奏：单账号串行、群间 LLM 间隔 600ms，摊平瞬时成本；产物走 cs:issue:changed 广播（新问题提醒见渲染端）；
 * - 配置：issue.autoScan.enabled（默认开，设置页「问题监控口径」可关闭；'0' = 关）。
 */
const SWEEP_MS = 60_000
const EVENT_MIN_GAP_MS = 15_000
const LLM_PACE_MS = 600
const CACHE_TTL_MS = 5 * 60_000
const CACHE_MIN_AGE_FOR_SESSION_REFRESH_MS = 30_000
const GROUP_NOTIFY_MIN_MS = 20 * 60_000
const AUTO_SCAN_KEY = 'issue.autoScan.enabled'

const timers = new Map<string, ReturnType<typeof setInterval>>()
const runningPass = new Set<string>()
const lastPassAt = new Map<string, number>()
const groupNotifiedAt = new Map<string, number>()
const cache = new Map<
  string,
  { at: number; list: Array<{ username: string; displayName: string }> }
>()
let hookInstalled = false

const enabled = (): boolean => getConfig(AUTO_SCAN_KEY) !== '0'

function sendChanged(wxid: string, added: number): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('cs:issue:changed', { at: Date.now(), wxid, added })
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
  try {
    const groups = listCandidates(wxid)
    for (const g of groups) {
      // 冷启动保护：尚无水位的群跳过（首次全量由打开群/手动分析触发），后台只做增量
      if (!hasGroupWatermark(wxid, g.username)) continue
      const r = await analyzeGroupIssues(wxid, g.username, g.displayName).catch(() => null)
      if (r && r.ok && !r.skipped && r.count && r.count > 0) {
        const k = `${wxid}|${g.username}`
        const last = groupNotifiedAt.get(k)
        const now = Date.now()
        if (!last || now - last >= GROUP_NOTIFY_MIN_MS) {
          groupNotifiedAt.set(k, now)
          sendChanged(wxid, r.count)
        }
      }
      if (r && r.ok && !r.skipped && r.method === 'llm') {
        await new Promise((res) => setTimeout(res, LLM_PACE_MS))
      }
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
  if (!hookInstalled) {
    addDbChangeHook(onDbChanged)
    hookInstalled = true
  }
  timers.set(
    wxid,
    setInterval(() => void runPass(wxid), SWEEP_MS)
  )
  void runPass(wxid)
}

/** 账号断开 / 停止监控时停止调度 */
export function remove(wxid: string): void {
  const t = timers.get(wxid)
  if (t) {
    clearInterval(t)
    timers.delete(wxid)
  }
  runningPass.delete(wxid)
  cache.delete(wxid)
  lastPassAt.delete(wxid)
}

/** 应用退出时全部停止 */
export function stopAll(): void {
  for (const t of timers.values()) clearInterval(t)
  timers.clear()
  runningPass.clear()
  cache.clear()
  lastPassAt.clear()
  groupNotifiedAt.clear()
  hookInstalled = false
}
