import type { SendResult, SendStatusInfo } from '../../../shared/types'
import { sendToChat, injectEnabled } from '../wechat/injector'
import * as wxService from '../wechat/wxService'
import { insertSendLog, countTodaySent } from '../../db/repos/sendLog'
import { getConfigNumber, getConfigBoolean, setConfig } from '../../db/repos/config'

/**
 * 发送执行层（T8，方案 §4.5）。
 * - 全局串行队列：注入是独占资源，多任务排队逐个执行
 * - 拟人化延迟：发送前随机 0.9~2.6s
 * - 频控：每日上限（默认 200）
 * - 闭环校验：发完查微信库确认发出/发对，失败熔断
 * - 审计：send_log 落库
 */

export type SendMode = 'manual' | 'confirm' | 'auto'

interface SendJob {
  wxid: string
  sessionId: string
  targetName: string
  text: string
  mode: SendMode
  source: string
  resolve: (r: SendResult) => void
}

/** 连续校验失败熔断阈值 */
const FAIL_THRESHOLD = 2

const queue: SendJob[] = []
let draining = false
let halted = false
let failStreak = 0

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 拟人化延迟毫秒（可配置关闭） */
function humanDelay(): number {
  if (!getConfigBoolean('send.humanizeDelay', true)) return 0
  return Math.floor(900 + Math.random() * 1700)
}

function dailyLimit(): number {
  return getConfigNumber('send.dailyLimit', 200)
}

/** 闭环校验：发完查微信库确认发出的消息存在（发对会话由 targetName 搜索保证） */
async function verifySend(
  wxid: string,
  sessionId: string,
  text: string
): Promise<{ verified: boolean; verifiable: boolean; reason?: string }> {
  try {
    const res = await wxService.getMessages(wxid, sessionId, 20, 0)
    if (!res.ok || !res.messages) {
      return { verified: false, verifiable: false, reason: res.error || '微信库不可读' }
    }
    const recent = res.messages.filter((m) => m.isSend).slice(-5)
    const hit = recent.some((m) => {
      const c = m.parsedContent || m.rawContent
      return c.length > 0 && (c.includes(text) || text.includes(c))
    })
    return { verified: hit, verifiable: true, reason: hit ? undefined : '未在最近消息中匹配到发送内容' }
  } catch (e) {
    return { verified: false, verifiable: false, reason: e instanceof Error ? e.message : '校验失败' }
  }
}

async function drain(): Promise<void> {
  if (draining) return
  draining = true
  while (queue.length > 0) {
    const job = queue.shift()!
    const at = Date.now()
    // 熔断检查
    if (halted) {
      job.resolve({ ok: false, status: 'halted', error: '系统已熔断，发送被拦截', verified: false, at })
      continue
    }
    // 频控检查
    if (countTodaySent() >= dailyLimit()) {
      job.resolve({
        ok: false,
        status: 'rejected',
        error: `今日发送已达上限（${dailyLimit()} 条）`,
        verified: false,
        at
      })
      continue
    }
    if (!injectEnabled()) {
      job.resolve({ ok: false, status: 'rejected', error: '注入发送已手动关闭', verified: false, at })
      continue
    }

    // 拟人化延迟
    await sleep(humanDelay())

    const inject = await sendToChat(job.targetName, job.text)
    let result: SendResult
    if (!inject.ok) {
      result = {
        ok: false,
        status: 'failed',
        error: inject.error || '注入失败',
        verified: false,
        at: Date.now()
      }
    } else {
      // 注入成功 → 闭环校验
      const v = await verifySend(job.wxid, job.sessionId, job.text)
      if (v.verified) {
        failStreak = 0
        result = { ok: true, status: 'sent', verified: true, at: Date.now() }
      } else if (v.verifiable) {
        // 明确没找到 → 发错/未发出，熔断计数
        failStreak += 1
        if (failStreak >= FAIL_THRESHOLD) {
          halted = true
          setConfig('send.halted', '1')
        }
        result = {
          ok: false,
          status: 'failed',
          error: v.reason || '发送未确认',
          verified: false,
          at: Date.now()
        }
      } else {
        // 无法校验（解密层未接入等）→ 乐观标记 sent，不熔断
        result = { ok: true, status: 'sent', verified: false, at: Date.now() }
      }
    }

    // 审计落库
    insertSendLog({
      sessionId: job.sessionId,
      message: job.text,
      mode: job.mode,
      source: job.source,
      result: result.status,
      errorReason: result.error,
      verified: result.verified,
      createdAt: at
    })

    // 会话间间隔（随机 2.5~7s，仅当还有排队任务时）
    if (queue.length > 0 && getConfigBoolean('send.humanizeDelay', true)) {
      await sleep(Math.floor(2500 + Math.random() * 4500))
    }

    job.resolve(result)
  }
  draining = false
}

/** 入队发送（人工/确认/自动统一走此链路） */
export function enqueueSend(
  job: Omit<SendJob, 'resolve'>
): Promise<SendResult> {
  return new Promise<SendResult>((resolve) => {
    queue.push({ ...job, resolve })
    void drain()
  })
}

export function isHalted(): boolean {
  return halted
}

export function resetCircuit(): void {
  halted = false
  failStreak = 0
  setConfig('send.halted', '0')
}

export function getSendStatus(): SendStatusInfo {
  return {
    halted,
    queued: queue.length,
    todayCount: countTodaySent(),
    dailyLimit: dailyLimit()
  }
}

/** 关停（退出时清理） */
export function stopSending(): void {
  halted = true
  queue.splice(0)
}
