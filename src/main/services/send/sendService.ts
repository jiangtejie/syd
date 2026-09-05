import type { SendResult, SendStatusInfo } from '../../../shared/types'
import { sendToChat, sendFileToChat, injectEnabled } from '../wechat/injector'
import * as wxService from '../wechat/wxService'
import { insertSendLog, countTodaySent } from '../../db/repos/sendLog'
import { getConfigNumber, getConfigBoolean, setConfig } from '../../db/repos/config'
import { createLogger } from '../logging'

const sendLog = createLogger('send')

/**
 * 发送执行层（T8，方案 §4.5）。
 * - 全局串行队列：注入是独占资源，多任务排队逐个执行
 * - 拟人化延迟：发送前随机 0.9~2.6s
 * - 频控：每日上限（默认 200）
 * - 闭环校验：发完查微信库确认发出/发对，失败熔断
 * - 审计：send_log 落库
 */

export type SendMode = 'manual' | 'confirm' | 'auto'

/** 文件任务载荷(一次一条:图片或普通文件) */
export interface SendFilePayload {
  path: string
  kind: 'image' | 'file'
  /** 用于审计与提示的展示名 */
  name: string
}

interface SendJob {
  wxid: string
  sessionId: string
  targetName: string
  text: string
  file?: SendFilePayload
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
    const res = await wxService.getMessages(wxid, sessionId, 20)
    if (!res.ok || !res.messages) {
      return { verified: false, verifiable: false, reason: res.error || '微信库不可读' }
    }
    const recent = res.messages.filter((m) => m.isSend).slice(-5)
    const hit = recent.some((m) => {
      const c = m.parsedContent || m.rawContent
      return c.length > 0 && (c.includes(text) || text.includes(c))
    })
    return {
      verified: hit,
      verifiable: true,
      reason: hit ? undefined : '未在最近消息中匹配到发送内容'
    }
  } catch (e) {
    return {
      verified: false,
      verifiable: false,
      reason: e instanceof Error ? e.message : '校验失败'
    }
  }
}

/** 文件/图片弱校验:最近已发消息中是否出现图片(3)或文件(49)类;仅作提示不作熔断依据 */
async function verifyFileSend(
  wxid: string,
  sessionId: string,
  kind: 'image' | 'file'
): Promise<{ verified: boolean; verifiable: boolean; reason?: string }> {
  try {
    const res = await wxService.getMessages(wxid, sessionId, 30)
    if (!res.ok || !res.messages) {
      return { verified: false, verifiable: false, reason: res.error || '微信库不可读' }
    }
    const recent = res.messages.filter((m) => m.isSend).slice(-6)
    const hit = recent.some((m) => {
      if (m.localType === 3) return kind === 'image'
      if (m.localType === 49) return true
      return false
    })
    return {
      verified: hit,
      verifiable: true,
      reason: hit ? undefined : '未在最近消息中发现图片/文件类消息'
    }
  } catch (e) {
    return {
      verified: false,
      verifiable: false,
      reason: e instanceof Error ? e.message : '校验失败'
    }
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
      job.resolve({
        ok: false,
        status: 'halted',
        error: '系统已熔断，发送被拦截',
        verified: false,
        at
      })
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
      job.resolve({
        ok: false,
        status: 'rejected',
        error: '注入发送已手动关闭',
        verified: false,
        at
      })
      continue
    }

    // 拟人化延迟
    await sleep(humanDelay())

    let result: SendResult
    if (job.file) {
      // 图片/文件发送:注入后等待微信落库,再做“种类级”弱校验(文件无正文可比,不参与熔断)
      const inject = await sendFileToChat(job.targetName, job.file.path, job.file.kind)
      if (!inject.ok) {
        result = {
          ok: false,
          status: 'failed',
          error: inject.error || '注入失败',
          verified: false,
          at: Date.now()
        }
      } else {
        await sleep(900)
        const v = await verifyFileSend(job.wxid, job.sessionId, job.file.kind)
        if (v.verified) {
          failStreak = 0
          result = { ok: true, status: 'sent', verified: true, at: Date.now() }
        } else {
          // 文件消息在库内字段差异大,未匹配到不视为失败,乐观标记
          result = { ok: true, status: 'sent', verified: false, at: Date.now() }
        }
      }
    } else {
      const inject = await sendToChat(job.targetName, job.text)
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
    }

    // 审计落库(文件任务以 [图片]/[文件] + 文件名 记录)
    const auditText = job.file
      ? `[${job.file.kind === 'image' ? '图片' : '文件'}] ${job.file.name}`
      : job.text
    insertSendLog({
      sessionId: job.sessionId,
      message: auditText,
      mode: job.mode,
      source: job.source,
      result: result.status,
      errorReason: result.error,
      verified: result.verified,
      createdAt: at
    })
    sendLog.info(
      `发送完成 ${job.source}/${job.mode} target=${job.targetName.slice(0, 24)} item=${auditText.slice(
        0,
        100
      )} => status=${result.status} verified=${result.verified ?? 'n/a'}${
        result.error ? ` err=${result.error.slice(0, 200)}` : ''
      }`
    )

    // 会话间间隔（随机 2.5~7s，仅当还有排队任务时）
    if (queue.length > 0 && getConfigBoolean('send.humanizeDelay', true)) {
      await sleep(Math.floor(2500 + Math.random() * 4500))
    }

    job.resolve(result)
  }
  draining = false
}

/** 入队发送（人工/确认/自动统一走此链路） */
export function enqueueSend(job: Omit<SendJob, 'resolve'>): Promise<SendResult> {
  return new Promise<SendResult>((resolve) => {
    queue.push({ ...job, resolve })
    void drain()
  })
}

/** 入队单条文件/图片发送(与文本同一队列,独占注入资源,统一频控/延迟/审计) */
export function enqueueSendFile(job: Omit<SendJob, 'resolve' | 'text'>): Promise<SendResult> {
  return enqueueSend({ ...job, text: '' })
}

export function isHalted(): boolean {
  return halted
}

export function resetCircuit(): void {
  halted = false
  failStreak = 0
  setConfig('send.halted', '0')
  sendLog.info('熔断已复位')
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
