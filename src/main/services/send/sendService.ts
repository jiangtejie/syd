import type { SendResult, SendStatusInfo } from '../../../shared/types'
import { sendToChat, sendFileToChat, injectEnabled } from '../wechat/injector'
import * as wxService from '../wechat/wxService'
import { insertSendLog, countTodaySent } from '../../db/repos/sendLog'
import { getConfigNumber, getConfigBoolean, setConfig } from '../../db/repos/config'
import { pickUniqueTarget, textMatchesSent, type GuardSession } from './guard'
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
/** 队列上限：人工 + AI 工具 + 值班通道都可能入队，堆太多只会雪崩 */
const MAX_QUEUE = 20
/**
 * 「注入成功但库里没匹配到文本」时，是否还看会话里有没有新发出的消息：
 * 有 → 判为已发送（未逐字校验）；没有 → 才算真失败并计入熔断。
 * 这样避免「微信截断/换行差异」把正常发送误判成失败、进而误熔断。
 */
const VERIFY_NEW_MSG_WINDOW_MS = 120_000

const queue: SendJob[] = []
let draining = false
let halted = false
let failStreak = 0
/** 熔断状态是否已从配置读回（模块加载时数据库可能还没就绪，用惰性读数） */
let hydrated = false

/** 熔断是持久状态：重启后必须还在（以前只写不读，重启就自动复活继续发） */
function hydrateOnce(): void {
  if (hydrated) return
  hydrated = true
  try {
    if (getConfigBoolean('send.halted', false)) {
      halted = true
      sendLog.warn('读取到上次的熔断状态：发送保持拦截，确认无误后到「设置 → 发送」复位')
    }
  } catch {
    /* 数据库尚未就绪：下一次调用再试 */
    hydrated = false
  }
}

/** 会话列表短缓存：一轮批量发送不必每个任务都读一次库 */
let sessionsCache: { wxid: string; at: number; list: GuardSession[] } | null = null
const SESSIONS_TTL_MS = 30_000

function guardSessions(wxid: string): GuardSession[] {
  if (
    sessionsCache &&
    sessionsCache.wxid === wxid &&
    Date.now() - sessionsCache.at < SESSIONS_TTL_MS
  ) {
    return sessionsCache.list
  }
  const res = wxService.getSessions(wxid)
  const list: GuardSession[] = res.ok
    ? (res.sessions ?? []).map((s) => ({
        username: s.username,
        displayName: s.displayName || s.nickname || s.remark || s.username
      }))
    : []
  sessionsCache = { wxid, at: Date.now(), list }
  return list
}

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

/**
 * 闭环校验：发完查微信库确认消息真的落地。
 *
 * 两种"没匹配到"要分开看，否则会误熔断：
 * - 会话里**没有**新发出的消息 → 真失败（计入熔断）；
 * - 有新的我方消息、只是文本没逐字匹配（微信截断/换行/表情差异）→ 判为已发送（未逐字校验），不计熔断。
 */
async function verifySend(
  wxid: string,
  sessionId: string,
  text: string,
  sinceMs: number
): Promise<{ verified: boolean; verifiable: boolean; sawOutgoing?: boolean; reason?: string }> {
  try {
    const res = await wxService.getMessages(wxid, sessionId, 30)
    if (!res.ok || !res.messages) {
      return { verified: false, verifiable: false, reason: res.error || '微信库不可读' }
    }
    const mine = res.messages.filter((m) => m.isSend)
    const hit = mine
      .slice(-5)
      .some((m) => textMatchesSent(m.parsedContent || m.rawContent || '', text))
    if (hit) return { verified: true, verifiable: true }
    const sawOutgoing = mine.some((m) => m.createTime >= sinceMs - VERIFY_NEW_MSG_WINDOW_MS)
    return {
      verified: false,
      verifiable: true,
      sawOutgoing,
      reason: sawOutgoing
        ? '会话里有新发出的消息，但文本未逐字匹配'
        : '未在会话最近消息中发现新发出的内容'
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

/**
 * 注入失败里哪些可以安全重试：
 * 只重试「还没进入粘贴正文」的错误（焦点被抢 / 剪贴板占用 / 窗口没找到）——
 * 这类重试不会造成重复发送；而「注入返回成功但校验失败」绝不能重试（可能已经发出去了）。
 */
function isRetryableInjectError(error: string | undefined): boolean {
  if (!error) return false
  // 状态未知(可能已经发出去了)绝不重试:那样就是重复消息
  if (/状态未知/.test(error)) return false
  // 「正文没进输入框」「窗口不可点击」都发生在回车之前 → 重试是安全的；
  // 锁屏不算错误而是环境问题,重试多半还是锁着,交人工。
  return /焦点被抢|剪贴板|未检测到微信窗口|未在限时内响应|超时|微信搜索框没能打开|截图\/识别失败|正文没能进到聊天输入框|微信窗口不可点击|focus stolen|clipboard busy|window not found|search box did not open|wrong chat opened|screenshot failed|ocr failed|body text is not in the chat input|not clickable|timed? ?out/i.test(
    error
  )
}

/** 带一次安全重试的注入 */
async function injectWithRetry<T extends { ok: boolean; error?: string }>(
  run: () => Promise<T>,
  label: string
): Promise<T> {
  const first = await run()
  if (first.ok || !isRetryableInjectError(first.error)) return first
  sendLog.warn(`注入失败将重试一次（${label}）: ${first.error}`)
  await sleep(1500)
  return run()
}

async function drain(): Promise<void> {
  if (draining) return
  hydrateOnce()
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

    // 目标唯一性预检：搜索结果第一行未必是目标群，重名/前缀撞车时必须拒绝（否则发错群收不回）
    // 会话名清单同时交给注入脚本：它读完「实际打开的会话标题」后拿这张表做最近邻比对，
    // 比目标更接近别的会话名就中止——这是发错群前的最后一道闸门。
    const sessions = guardSessions(job.wxid)
    const decision = pickUniqueTarget(sessions, job.sessionId, job.targetName)
    const injectCtx = {
      names: sessions.map((s) => s.displayName),
      isGroup: /@chatroom$/i.test(job.sessionId)
    }
    if (!decision.ok) {
      sendLog.warn(`发送已拦截（目标不唯一）: ${decision.error ?? ''}`)
      job.resolve({
        ok: false,
        status: 'rejected',
        error: decision.error,
        verified: false,
        at
      })
      continue
    }

    // 拟人化延迟
    await sleep(humanDelay())

    let result: SendResult
    /** 注入脚本 OCR 读回的「实际打开会话」,写进日志便于事后审计 */
    let openedChat = ''
    if (job.file) {
      // 图片/文件发送:注入后等待微信落库,再做“种类级”弱校验(文件无正文可比,不参与熔断)
      const inject = await injectWithRetry(
        () => sendFileToChat(decision.name, job.file!.path, job.file!.kind, injectCtx),
        'file'
      )
      openedChat = inject.opened ?? ''
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
      const inject = await injectWithRetry(
        () => sendToChat(decision.name, job.text, injectCtx),
        'text'
      )
      openedChat = inject.opened ?? ''
      if (!inject.ok) {
        result = {
          ok: false,
          status: 'failed',
          error: inject.error || '注入失败',
          verified: false,
          at: Date.now()
        }
      } else {
        // 注入成功 → 闭环校验（文本未逐字匹配但会话里确有新发出消息 → 视为已发送，不熔断）
        const v = await verifySend(job.wxid, job.sessionId, job.text, at)
        if (v.verified) {
          failStreak = 0
          result = { ok: true, status: 'sent', verified: true, at: Date.now() }
        } else if (v.verifiable && v.sawOutgoing) {
          failStreak = 0
          sendLog.info(`发送未逐字校验（${v.reason ?? ''}）target=${decision.name.slice(0, 24)}`)
          result = { ok: true, status: 'sent', verified: false, at: Date.now() }
        } else if (v.verifiable) {
          // 会话里没有新发出的消息 → 真失败，熔断计数
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
        openedChat ? ` opened=${openedChat.slice(0, 40)}` : ''
      }${result.error ? ` err=${result.error.slice(0, 200)}` : ''}`
    )

    // 会话间间隔（随机 2.5~7s，仅当还有排队任务时）
    if (queue.length > 0 && getConfigBoolean('send.humanizeDelay', true)) {
      await sleep(Math.floor(2500 + Math.random() * 4500))
    }

    job.resolve(result)
  }
  draining = false
}

/** 入队发送（人工/确认/自动统一走此链路）；队列有上限，满了直接拒绝而不是无限堆积 */
export function enqueueSend(job: Omit<SendJob, 'resolve'>): Promise<SendResult> {
  return new Promise<SendResult>((resolve) => {
    hydrateOnce()
    if (queue.length >= MAX_QUEUE) {
      sendLog.warn(`发送队列已满（${MAX_QUEUE}），拒绝入队 source=${job.source}`)
      resolve({
        ok: false,
        status: 'rejected',
        error: `发送队列已满（${MAX_QUEUE} 条排队中），请稍后再试`,
        verified: false,
        at: Date.now()
      })
      return
    }
    queue.push({ ...job, resolve })
    void drain()
  })
}

/** 入队单条文件/图片发送(与文本同一队列,独占注入资源,统一频控/延迟/审计) */
export function enqueueSendFile(job: Omit<SendJob, 'resolve' | 'text'>): Promise<SendResult> {
  return enqueueSend({ ...job, text: '' })
}

export function isHalted(): boolean {
  hydrateOnce()
  return halted
}

export function resetCircuit(): void {
  halted = false
  failStreak = 0
  setConfig('send.halted', '0')
  sendLog.info('熔断已复位')
}

export function getSendStatus(): SendStatusInfo {
  hydrateOnce()
  return {
    halted,
    queued: queue.length,
    todayCount: countTodaySent(),
    dailyLimit: dailyLimit()
  }
}

/** 关停（退出/用户手动停止）：清空队列，并让每个排队任务都 settle（否则渲染端 invoke 永久挂起） */
export function stopSending(): void {
  halted = true
  for (const job of queue.splice(0)) {
    job.resolve({
      ok: false,
      status: 'halted',
      error: '已停止发送队列',
      verified: false,
      at: Date.now()
    })
  }
}
