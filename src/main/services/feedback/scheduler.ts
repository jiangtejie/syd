import { addDbChangeHook, type DbChangedPayload } from '../wechat/watchService'
import {
  invalidateCandidates,
  resetExtractState,
  runExtractOnDbEvent,
  runExtractPass
} from './passes/extract'
import { resetSettleState, runSettlePass } from './passes/settle'
import { resetEscalateState, runEscalatePass } from './passes/escalate'
import { resetReplyState, runReplyPass } from './passes/reply'
import { maybeSendDailyDigest } from './digest'
import { issueLog } from './passes/shared'

/**
 * 群问题后台调度器（入口）。
 *
 * 只做三件事：账号级定时器、库变更钩子、把四条通道按各自节奏跑起来 ——
 * 具体职责都在 passes/ 下（extract 增量提取 / settle 收尾巡检 / escalate 盯办升级 /
 * reply 数字员工值班），
 * 这样一条通道改坏不会牵连另外两条，也便于单独读。
 *
 * 节奏：
 * - 每 60s 一次 tick：增量提取 + 盯办升级；
 * - 每 2 次 tick（≈2 分钟）：收尾巡检（零 LLM，只跑有 open 问题的群）——
 *   跟进状态要「有人回复就尽快变」，而增量提取那条路有 2 分钟节流、无新消息时还会直接 skip；
 * - 每 2 次 tick（≈2 分钟）：数字员工值班（影子期只记录；live 时由通道内自己控节奏到 50s）；
 * - 每 tick：检查「每日日报」是否到点（到点且当天未发才发，见 digest.ts）；
 * - 微信群库变化事件：立即触发一轮增量提取（内部 15s 冷却）。
 */
const SWEEP_MS = 60_000
/** 收尾巡检周期（按 tick 计数）：60s × 2 = 每 2 分钟 */
const SETTLE_EVERY_TICKS = 2

const timers = new Map<string, ReturnType<typeof setInterval>>()
const tickCount = new Map<string, number>()
/** 事件钩子取消函数：注册后必须能注销，否则 stopAll 后再 ensure 会累积永不清理的回调 */
let uninstallHook: (() => void) | null = null

/** 微信库变化：会话列表变了就失效候选缓存，随后按冷却触发一轮增量提取 */
function onDbChanged(payload: DbChangedPayload): void {
  if (!timers.has(payload.wxid)) return
  if (payload.info.sessionChanged) invalidateCandidates(payload.wxid)
  runExtractOnDbEvent(payload.wxid)
}

/** 账号接入后启动：注册事件钩子（全局一次）+ 每 60s 巡检 + 立即一轮 */
export function ensure(wxid: string): void {
  if (!wxid || timers.has(wxid)) return
  if (!uninstallHook) {
    uninstallHook = addDbChangeHook(onDbChanged)
  }
  const tick = (): void => {
    void runExtractPass(wxid)
    void runEscalatePass(wxid)
    // 值班通道每 tick 都试一次，内部按 shadow/live 各自的最小间隔自己节流
    void runReplyPass(wxid)
    // 每日日报：到点且当天没发过才发（幂等靠 lark.digest.lastDate）
    void maybeSendDailyDigest(wxid)
    const n = (tickCount.get(wxid) ?? 0) + 1
    tickCount.set(wxid, n)
    if (n % SETTLE_EVERY_TICKS === 0) void runSettlePass(wxid)
  }
  timers.set(wxid, setInterval(tick, SWEEP_MS))
  issueLog.debug(
    `群问题后台调度已启动 ${wxid}（提取 60s / 收尾 2min / 盯办 60s / 数字员工值班 60s）`
  )
  void runExtractPass(wxid)
  void runEscalatePass(wxid)
  void runReplyPass(wxid)
}

/** 应用退出或账号断开时全部停止 */
export function stopAll(): void {
  for (const t of timers.values()) clearInterval(t)
  timers.clear()
  tickCount.clear()
  resetExtractState()
  resetSettleState()
  resetEscalateState()
  resetReplyState()
  uninstallHook?.()
  uninstallHook = null
}
