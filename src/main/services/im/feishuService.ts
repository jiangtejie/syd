import { mkdir, writeFile } from 'node:fs/promises'
import {
  finishImAudit,
  findRunningImAudit,
  insertImAudit,
  startImAudit,
  updateImAuditProgress
} from '../../db/repos/imAuditRepo'
import { parseCapTier, setSessionCapTier, type CapTier } from '../ai/cap/tiers'
import { tryHandleFeishuCommand } from './feishuCommands'
import { join, relative } from 'node:path'
import { BrowserWindow } from 'electron'
import * as lark from '@larksuiteoapi/node-sdk'
import { getImAccountConfig, listMappedSessionIds } from '../../db/repos/imRepo'
import { appendChatMessage, lastAssistantText } from '../../db/repos/chatRepo'
import { insertFileRecord } from '../../db/repos/imFileRepo'
import { createLogger } from '../logging'
import { getFilesRootDir } from '../paths'
import { createImSession } from './sessionBridge'
import {
  confirmToolRun,
  isChatRunning,
  registerEventSink,
  sendChatMessage,
  stopChat
} from '../ai/chat/service'
import { ensureBoundBusinessMounts } from '../ai/cap/mounts'
import { openSecret } from '../secrets'
import { maxFileBytes, maxFileHint } from './channelFiles'
import { clipForChannel, feishuPlainText, isStopCommand } from './mdToPlain'
import { actionValueOf, approvalCard, operatorOpenIdOf, parseApprovalAction } from './cards'
import { toolCnName } from '../../../shared/types'
import type { AiChatEvent } from '../../../shared/types'

/**
 * 飞书机器人通道(IM 一期)。
 * - 官方 WebSocket 长连接收消息;响应 私聊(p2p)或群内被 @ 本应用 的 文本/图片/文件;
 * - 每个外部聊天自动映射一个本地 AI 会话(独立上下文,复用记忆/工具/ReAct 引擎);
 * - 图片/文件:下载到 userData/im-files/acct-<账号>/user-<open_id>/<yyyyMMdd>/,
 *   并在该会话上下文补一条「对方发送了图片/文件」留痕(不触发 AI 生成);
 * - 回复走原消息 reply;长文本按 3000 字分片;
 * - 事件处理立即 ack(长连接 3s 内需应答,超时平台会重推),AI 生成异步进行,结果用
 *   REST API 回发(与长连接状态无关),同一 message_id 去重防平台重推造成双回复。
 *
 * 注意:必须使用当前 SDK 的 WSClient API —— 事件通过 EventDispatcher 注册并传入
 * start({ eventDispatcher }),WSClient 没有 on() 方法(旧实现 wsc.on() 运行时抛错,
 * 导致“看似已启用其实从未建立长连接”,即历史 Bug)。
 */

/** 飞书通道日志:统一走主进程 logger(scope=im,消息带账号前缀;控制台/磁盘由 logger 负责) */
const imLogger = createLogger('im')
function imLog(accountId: number | string, text: string): void {
  imLogger.info(`${accountId === 'ai' ? 'ai' : `acct=${accountId}`} ${text}`)
}

interface ImMessage {
  message_id?: string
  chat_id?: string
  chat_type?: string
  message_type?: string
  content?: string
  mentions?: Array<{ key?: string; id?: Record<string, string> }>
}

interface Runtime {
  accountId: number
  appId: string
  /** 绑定的微信业务账号 wxid(空 = 通用对话,业务工具不可用) */
  businessWxid: string
  /** 业务查询白名单(逗号分隔用户标识;绑定后非空即启用) */
  allowUsers: string[]
  /** 接收策略(off 仅推送 / allowlist 只收白名单私聊 / all 全收) */
  receiveMode: 'off' | 'allowlist' | 'all'
  /** 指令权限名单(open_id → 档位;白名单内未列出者默认 operator) */
  permissions: Record<string, string>
  client: {
    im: {
      message: {
        reply: (opts: {
          path: { message_id: string }
          data: { msg_type: 'text' | 'interactive'; content: string }
        }) => Promise<unknown>
      }
    }
  }
  wsc: { start: (p: { eventDispatcher: unknown }) => Promise<void>; close?: () => void } | null
  name: string
  status: 'connected' | 'connecting' | 'error'
  statusText: string
  lastError?: string
  /** 最近处理过的 message_id → 时间,平台超时重推时去重 */
  recent: Map<string, number>
  /** 建连看门狗:start 后若长时间无 onReady 则报错提示 */
  watchdog?: ReturnType<typeof setTimeout> | null
}

const runtimes = new Map<number, Runtime>()
/** 事件 ack 后平台若 3s 内没收到应答会重推;去重窗口 10 分钟 */
const DEDUP_MS = 10 * 60_000
const CONNECT_TIMEOUT_MS = 20_000

/* ── 忙碌续答(轻量队列):会话正在生成时新消息只保留「最新一条」,上一轮完成后自动续答 ── */

interface PendingItem {
  text: string
  messageId: string
  /** 审计/任务行 id(进度与结果都回填到这一行) */
  logId?: number | null
  /** 发起人 open_id(工具审批卡片只允许发起人点按钮) */
  senderOpenId?: string
}

/** sessionId → 待续答内容(覆盖式:同会话多条只留最新) */
const pendingQueue = new Map<number, PendingItem>()
/** 正在执行 drain 的会话(防重复起循环) */
const draining = new Set<number>()
/** 高危工具二次确认:引擎已挂起等待桌面确认,由本会话用户在飞书里答复 */
const feishuConfirm = new Map<string, { runId: string; operatorOpenId?: string }>()
/** 等待引擎空闲的最长时间:超过则放弃排队并提示 */
const IDLE_WAIT_MS = 5 * 60_000

const CONFIRM_YES = new Set(['确认', '确认发送', '同意', '同意发送', '确认执行', 'yes', 'ok', 'y'])
const CONFIRM_NO = new Set(['取消', '拒绝', '不同意', '拒绝发送', '不发送', 'no', 'n', 'cancel'])

/** 审计/任务落库:任何失败都不影响主流程(审计不能成为单点) */
function auditStart(input: {
  accountId: number
  chatId: string
  sessionId: number | null
  senderOpenId: string
  chatType: string
  kind: 'command' | 'message' | 'rejected'
  text: string
  status?: 'queued' | 'skipped'
  error?: string
}): number | null {
  try {
    return insertImAudit(input)
  } catch {
    return null
  }
}

function auditFinish(
  id: number | null,
  patch: {
    status: 'ok' | 'error' | 'skipped' | 'done' | 'failed' | 'cancelled'
    tools?: string[]
    replyLen?: number
    elapsedMs?: number
    error?: string
    result?: string
  }
): void {
  try {
    finishImAudit(id, patch)
  } catch {
    /* 审计失败不影响回复 */
  }
}

function auditProgress(id: number | null, progress: string): void {
  try {
    updateImAuditProgress(id, progress)
  } catch {
    /* ignore */
  }
}

function auditBegin(id: number | null): void {
  try {
    startImAudit(id)
  } catch {
    /* ignore */
  }
}

/** 拆白名单配置(逗号/换行分隔) */
function parseAllowUsers(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/[,\s，]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 发送者标识是否命中白名单(三种 id 任一命中即可) */
function inAllowList(rt: Runtime, senderIds: SenderIds): boolean {
  const ids = [senderIds.openId, senderIds.unionId, senderIds.userId].filter(Boolean)
  return rt.allowUsers.some((w) => ids.includes(w))
}

/**
 * 入站准入(接收策略):
 *  - off:不接收(本不该走到这里,双保险);
 *  - allowlist:只收白名单内同事的**私聊**,群消息一律拒绝;白名单为空时**全拒**(fail-closed);
 *  - all:私聊全收;群聊需 @ 机器人;白名单非空时仍按名单过滤(不限是否绑定业务账号)。
 * 返回 null 表示放行,否则返回拒绝原因(写日志/审计用)。
 */
function admitInbound(
  rt: Runtime,
  msg: ImMessage,
  senderIds: SenderIds,
  appId: string
): string | null {
  if (rt.receiveMode === 'off') return '接收策略为「仅推送」'
  if (rt.receiveMode === 'allowlist') {
    if (msg.chat_type !== 'p2p') return '接收策略只允许私聊(已拒绝群消息)'
    if (rt.allowUsers.length === 0) return '未配置接收白名单(拒绝所有来源)'
    return inAllowList(rt, senderIds) ? null : '不在接收白名单内'
  }
  // all:群聊需 @ 本应用
  if (msg.chat_type !== 'p2p') {
    const mentionedApp = (msg.mentions ?? []).some((m) => {
      const id = m.id ?? {}
      return id.app_id === appId || Object.keys(id).length === 0
    })
    if (!mentionedApp) return '群聊未@本应用'
  }
  if (rt.allowUsers.length > 0 && !inAllowList(rt, senderIds)) return '不在接收白名单内'
  return null
}

/** 等待引擎对该会话空闲(轮询;超时返回 false) */
async function waitIdle(wxid: string, sessionId: number): Promise<boolean> {
  const deadline = Date.now() + IDLE_WAIT_MS
  while (isChatRunning(wxid, sessionId)) {
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, 800))
  }
  return true
}

export function getImStatus(accountId: number): { status?: string; statusText?: string } {
  const r = runtimes.get(accountId)
  return r ? { status: r.status, statusText: r.lastError ?? r.statusText } : {}
}

function setStatus(rt: Runtime, status: Runtime['status'], text: string, err?: unknown): void {
  rt.status = status
  rt.statusText = text
  rt.lastError = err instanceof Error ? err.message : err ? String(err) : undefined
  if (status === 'connected' && rt.watchdog) {
    clearTimeout(rt.watchdog)
    rt.watchdog = null
  }
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('cs:im:status', {
      accountId: rt.accountId,
      status: rt.status,
      statusText: rt.lastError ?? rt.statusText,
      at: Date.now()
    })
  }
  imLog(rt.accountId, `状态变更 -> ${status}: ${rt.lastError ?? rt.statusText}`)
}

/** 是否近期已处理过该消息(去重) */
function isDuplicate(rt: Runtime, messageId: string): boolean {
  const now = Date.now()
  for (const [k, t] of rt.recent) {
    if (now - t > DEDUP_MS) rt.recent.delete(k)
  }
  if (rt.recent.size > 400) {
    for (const k of rt.recent.keys()) {
      rt.recent.delete(k)
      if (rt.recent.size <= 200) break
    }
  }
  if (rt.recent.has(messageId)) return true
  rt.recent.set(messageId, now)
  return false
}

interface SenderIds {
  openId?: string
  unionId?: string
  userId?: string
}

/**
 * 事件载荷两种可能形态都兼容:
 * - 长连接(当前 SDK):EventDispatcher 解包后直接是事件体 { sender, message, ... };
 * - webhook 信封 { schema, header, event }:取 event 字段。
 */
function extractMessage(data: unknown): {
  msg?: ImMessage
  senderType?: string
  senderIds: SenderIds
} {
  const d = (data ?? {}) as {
    event?: unknown
    sender?: {
      sender_type?: string
      sender_id?: { open_id?: string; union_id?: string; user_id?: string }
    }
    message?: ImMessage
  }
  const body = (d.event && typeof d.event === 'object' ? d.event : d) as {
    message?: ImMessage
    sender?: {
      sender_type?: string
      sender_id?: { open_id?: string; union_id?: string; user_id?: string }
    }
  }
  const sid = body?.sender?.sender_id
  return {
    msg: body?.message,
    senderType: body?.sender?.sender_type,
    senderIds: {
      openId: sid?.open_id,
      unionId: sid?.union_id,
      userId: sid?.user_id
    }
  }
}

function parseText(raw: string | undefined): string {
  if (!raw) return ''
  try {
    const parsed = JSON.parse(raw) as { text?: string }
    return (parsed.text ?? '')
      .trim()
      .replace(/@_user_\d+/g, '')
      .trim()
  } catch {
    return ''
  }
}

/** 启用一个飞书账号(幂等;失败后允许重试) */
export async function startFeishuAccount(
  accountId: number,
  name: string
): Promise<{ ok: boolean; error?: string }> {
  const existing = runtimes.get(accountId)
  if (existing && existing.status !== 'error') {
    return { ok: true }
  }
  const cfg = getImAccountConfig(accountId)
  const appId = (cfg.appId ?? '').trim()
  const appSecret = openSecret(cfg.appSecret)
  if (!appId || !appSecret) {
    const msg = appId ? 'App Secret 缺失或无法解密,请重新编辑账号并填写 Secret' : '缺少 App ID'
    imLog(accountId, `启动失败:${msg}`)
    return { ok: false, error: msg }
  }
  if (!/^cli_[0-9a-fA-F]{16}$/.test(appId)) {
    const msg = `App ID 格式不正确:应为 cli_ 开头共 20 位(当前 "${appId.slice(0, 24)}")`
    imLog(accountId, `启动失败:${msg}`)
    return { ok: false, error: msg }
  }
  try {
    const client = new lark.Client({
      appId,
      appSecret,
      appType: lark.AppType.SelfBuild
    }) as unknown as Runtime['client']
    const dispatcher = new lark.EventDispatcher({}) as unknown as {
      register(map: Record<string, (data: unknown) => unknown>): unknown
    }

    const rt: Runtime = {
      accountId,
      appId,
      businessWxid: (cfg.wxid ?? '').trim(),
      allowUsers: parseAllowUsers(cfg.allowUsers),
      receiveMode: cfg.receiveMode ?? (cfg.pushOnly === true ? 'off' : 'all'),
      permissions: cfg.permissions ?? {},
      client,
      wsc: null,
      name,
      status: 'connecting',
      statusText: '连接中…',
      recent: new Map()
    }
    runtimes.set(accountId, rt)
    if (rt.receiveMode === 'off') {
      // 仅推送模式:不建立长连接、不注册任何事件 → 机器人不接收任何飞书消息(含外部群 @)
      setStatus(rt, 'connected', '仅推送模式(不接收消息)')
      imLog(
        accountId,
        `已启用「仅推送」模式(appId=${appId}):不建立长连接、不接收任何消息,仅用于主动推送`
      )
      return { ok: true }
    }
    imLog(
      accountId,
      `开始建立飞书长连接(appId=${appId}${
        rt.businessWxid ? `,绑定业务账号=${rt.businessWxid}` : '(未绑定业务账号,仅通用对话)'
      }${rt.businessWxid && rt.allowUsers.length > 0 ? `,白名单 ${rt.allowUsers.length} 人` : ''})`
    )
    // 绑定业务账号后,该账号已有映射会话补齐 L1 业务能力(历史通用会话立即具备查询能力)
    if (rt.businessWxid) {
      try {
        const sids = listMappedSessionIds(accountId)
        for (const sid of sids) ensureBoundBusinessMounts(sid)
        if (sids.length > 0) {
          imLog(
            accountId,
            `已为 ${sids.length} 个映射会话补齐微信业务能力(绑定 ${rt.businessWxid})`
          )
        }
      } catch (e) {
        imLog(accountId, `补齐映射会话能力失败:${e instanceof Error ? e.message : String(e)}`)
      }
    }

    // 事件处理:只做准入/白名单/去重,随即异步入队(handler 必须快速返回,3s 内 ack)
    const onReceive = (data: unknown): void => {
      const { msg, senderType, senderIds } = extractMessage(data)
      if (!msg?.message_id || !msg.chat_id) {
        imLog(
          accountId,
          `跳过:载荷缺少 message_id/chat_id ${JSON.stringify(data ?? {}).slice(0, 200)}`
        )
        return
      }
      if (senderType && senderType !== 'user') {
        imLog(accountId, `跳过:非用户消息 sender_type=${senderType}(${msg.message_id})`)
        return
      }
      const openId = senderIds.openId ?? senderIds.unionId ?? senderIds.userId ?? '?'
      // 准入(接收策略 + 白名单):拒绝原因写日志,便于排查"为什么没反应"
      const denied = admitInbound(rt, msg, senderIds, appId)
      if (denied) {
        imLog(
          accountId,
          `跳过:${denied} sender=${openId} chat=${msg.chat_type ?? '-'}(${msg.message_id})`
        )
        auditStart({
          accountId,
          chatId: msg.chat_id!,
          sessionId: null,
          senderOpenId: openId,
          chatType: msg.chat_type ?? '',
          text: '',
          kind: 'rejected',
          status: 'skipped',
          error: denied
        })
        return
      }
      if (isDuplicate(rt, msg.message_id)) {
        imLog(accountId, `跳过:重复推送 ${msg.message_id}`)
        return
      }
      const mtype = msg.message_type ?? ''
      if (mtype === 'image' || mtype === 'file') {
        imLog(
          accountId,
          `收到媒体 ${msg.message_id} type=${msg.chat_type} kind=${mtype} sender=${openId}`
        )
        // 与文本一致:先给"思考中"表情即时反馈,处理完(保存/拒收/失败)再移除或回执
        void addThinkingReaction(rt, msg.message_id!)
        void handleInboundMedia(
          accountId,
          rt,
          msg.chat_id!,
          msg.message_id!,
          mtype,
          msg.content,
          senderIds,
          openId
        )
        return
      }
      if (mtype !== 'text') {
        imLog(accountId, `跳过:暂不支持的媒体类型 ${mtype}(${msg.message_id})`)
        return
      }
      const text = parseText(msg.content)
      if (!text) {
        imLog(accountId, `跳过:文本为空(${msg.message_id})`)
        return
      }
      imLog(
        accountId,
        `收到消息 ${msg.message_id} type=${msg.chat_type} sender=${openId} len=${text.length}`
      )
      // 立即给消息加"思考中"表情回应,避免用户以为机器人卡住;正式回复发出后移除
      void addThinkingReaction(rt, msg.message_id!)
      void handleInbound(
        accountId,
        rt,
        msg.chat_id!,
        msg.message_id!,
        text,
        openId,
        msg.chat_type ?? ''
      )
    }
    /**
     * 交互卡片回调:工具审批的「确认/取消」按钮（替代回复「确认」的文本方式）。
     * 安全:确认态以 sessionId 为键、卡片 value 里带发起人 open_id —— 只有发起人能点。
     * 返回对象会作为回调应答(飞书据此弹 toast)。
     */
    const onCardAction = (data: unknown): Record<string, unknown> => {
      const parsed = parseApprovalAction(actionValueOf(data))
      if (!parsed) return {}
      const from = operatorOpenIdOf(data)
      let sessionKey = ''
      for (const [k, v] of feishuConfirm.entries()) {
        if (v.runId === parsed.runId) {
          sessionKey = k
          break
        }
      }
      if (!sessionKey) {
        return { toast: { type: 'info', content: '这条确认已失效(超时或已处理)' } }
      }
      const pending = feishuConfirm.get(sessionKey)
      if (pending?.operatorOpenId && from && pending.operatorOpenId !== from) {
        imLog(accountId, `卡片确认被非发起人点击:from=${from} 发起人=${pending.operatorOpenId}`)
        return { toast: { type: 'error', content: '只有发起这条指令的人可以确认' } }
      }
      feishuConfirm.delete(sessionKey)
      confirmToolRun(parsed.runId, parsed.allow)
      imLog(
        accountId,
        `卡片确认:${parsed.allow ? '同意' : '拒绝'} run=${parsed.runId} from=${from || '未知'}`
      )
      return {
        toast: {
          type: parsed.allow ? 'success' : 'info',
          content: parsed.allow ? '已确认,继续执行…' : '已取消本次操作'
        }
      }
    }
    dispatcher.register({
      'im.message.receive_v1': onReceive,
      'card.action.trigger': onCardAction
    })

    // 连接生命周期回调:真实状态(不要乐观置 connected)
    const wsc = new lark.WSClient({
      appId,
      appSecret,
      loggerLevel: lark.LoggerLevel.info,
      autoReconnect: true,
      onReady: () => {
        if (runtimes.get(accountId) !== rt) return
        imLog(accountId, 'WS 握手成功,长连接就绪')
        setStatus(rt, 'connected', '已连接(飞书长连接就绪)')
      },
      onReconnecting: () => {
        if (runtimes.get(accountId) !== rt) return
        setStatus(rt, 'connecting', '连接断开,自动重连中…')
      },
      onReconnected: () => {
        if (runtimes.get(accountId) !== rt) return
        setStatus(rt, 'connected', '已重连(飞书长连接就绪)')
      },
      onError: (err: Error) => {
        if (runtimes.get(accountId) !== rt) return
        const msg = err instanceof Error ? err.message : String(err)
        imLog(accountId, `WS 连接失败:${msg}`)
        setStatus(rt, 'error', '长连接失败', err)
      }
    } as ConstructorParameters<typeof lark.WSClient>[0])
    rt.wsc = wsc as unknown as Runtime['wsc']

    await wsc.start({ eventDispatcher: dispatcher as never })
    // 看门狗:SDK 断线会自动无限重连;若 20s 内从未就绪,多半是凭证/订阅配置问题
    rt.watchdog = setTimeout(() => {
      if (runtimes.get(accountId) !== rt) return
      if (rt.status !== 'connected') {
        const tip =
          rt.lastError ??
          '20 秒内未建立长连接:请检查 ① App ID/Secret 是否正确且已发布应用版本;② 开发者后台 事件与回调 → 订阅方式 选「长连接」并已订阅 im.message.receive_v1;③ 网络可访问 open.feishu.cn'
        imLog(accountId, `建连超时:${tip}`)
        setStatus(rt, 'error', '连接超时', new Error(tip))
      }
    }, CONNECT_TIMEOUT_MS)
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    imLog(accountId, `启动异常:${msg}`)
    runtimes.delete(accountId)
    return { ok: false, error: msg }
  }
}

export function stopFeishuAccount(accountId: number): void {
  const rt = runtimes.get(accountId)
  if (rt) {
    if (rt.watchdog) clearTimeout(rt.watchdog)
    try {
      rt.wsc?.close?.()
    } catch {
      /* ignore */
    }
    runtimes.delete(accountId)
    imLog(accountId, '已停用/关闭')
  }
}

export function stopAllFeishu(): void {
  for (const id of [...runtimes.keys()]) stopFeishuAccount(id)
}

/** 入站文本上限(与引擎单条历史截断一致;防超长粘贴烧 token) */
const MAX_INBOUND_CHARS = 6000

/** 外部聊天 → 本地会话 → 排队/续答 → AI 生成 → 结果回发 */
async function handleInbound(
  accountId: number,
  rt: Runtime,
  chatId: string,
  replyMessageId: string,
  text: string,
  senderOpenId: string,
  chatType: string
): Promise<void> {
  let auditId: number | null = null
  try {
    const sessionId = await createImSession(accountId, chatId, `${rt.name}·${chatId.slice(-8)}`)
    // 指令权限档位:名单内默认 operator;未列名单(如全收模式下的陌生人)默认 viewer
    const tier: CapTier | undefined =
      parseCapTier(rt.permissions[senderOpenId]) ??
      (rt.allowUsers.includes(senderOpenId) ? 'operator' : 'viewer')
    setSessionCapTier(sessionId, tier)
    const isCmd = text.trim().startsWith('/')
    const logId = auditStart({
      accountId,
      chatId,
      sessionId,
      senderOpenId,
      chatType,
      kind: isCmd ? 'command' : 'message',
      text
    })
    auditId = logId
    // 斜杠指令(/help、/tasks、/task、/cancel):零成本确定性返回,不进模型上下文
    const handled = await tryHandleFeishuCommand(
      {
        bound: !!rt.businessWxid,
        reply: (messageId, text2) => safeReply(rt, messageId, text2),
        removeReaction: (messageId) => void removeThinkingReaction(rt, messageId),
        log: (msg) => imLog(accountId, msg),
        finishAudit: (patch) => auditFinish(logId, { ...patch, elapsedMs: 0 })
      },
      {
        accountId,
        chatId,
        sessionId,
        messageId: replyMessageId,
        businessWxid: rt.businessWxid,
        text
      }
    )
    if (handled) return
    // 「停止」命令:会话正在生成则中止并确认;空闲时按普通消息交给 AI 解释
    if (isStopCommand(text)) {
      if (isChatRunning(rt.businessWxid, sessionId)) {
        const running = findRunningImAudit(rt.accountId, chatId)
        stopChat(rt.businessWxid, sessionId)
        if (running) auditFinish(running.id, { status: 'cancelled' })
        imLog(accountId, `用户要求停止,已中止会话 ${sessionId}`)
        await safeReply(rt, replyMessageId, '已停止生成 ✅')
        void removeThinkingReaction(rt, replyMessageId)
        return
      }
      imLog(accountId, `收到停止指令但无进行中的生成(当作普通消息处理)`)
    }
    // 高危工具二次确认:引擎正等人工确认(如代发微信),本条若为答复则消费并结束
    const pendingC = feishuConfirm.get(String(sessionId))
    if (pendingC) {
      const norm = text.trim().toLowerCase()
      if (CONFIRM_YES.has(norm) || CONFIRM_NO.has(norm)) {
        feishuConfirm.delete(String(sessionId))
        const ok = CONFIRM_YES.has(norm)
        imLog(accountId, `工具确认答复:${ok ? '同意' : '拒绝'} run=${pendingC.runId}`)
        confirmToolRun(pendingC.runId, ok)
        await safeReply(rt, replyMessageId, ok ? '已确认,继续执行…' : '已取消本次操作')
        void removeThinkingReaction(rt, replyMessageId)
        return
      }
    }
    const capped =
      text.length > MAX_INBOUND_CHARS
        ? `${text.slice(0, MAX_INBOUND_CHARS)}\n…(消息过长已截断)`
        : text
    // 队列:生成中到达的新消息只保留最新一条(覆盖式),由 drain 在空闲后续答。
    // 覆盖前把上一条收尾,避免留下永远「排队中/执行中」的孤儿记录。
    const prevItem = pendingQueue.get(sessionId)
    if (prevItem) {
      auditFinish(prevItem.logId ?? null, { status: 'cancelled', error: '被新指令取代' })
    }
    pendingQueue.set(sessionId, {
      text: capped,
      messageId: replyMessageId,
      logId,
      senderOpenId
    })
    if (draining.has(sessionId)) return
    draining.add(sessionId)
    void drainInbound(sessionId, rt).finally(() => draining.delete(sessionId))
  } catch (e) {
    const msg = e instanceof Error ? (e.stack ?? e.message) : String(e)
    imLog(accountId, `处理入站消息异常:${msg}`)
    auditFinish(auditId, { status: 'error', error: msg })
    await safeReply(
      rt,
      replyMessageId,
      `处理失败:${clipForChannel(String(e instanceof Error ? e.message : e))}`
    )
    void removeThinkingReaction(rt, replyMessageId)
  }
}

/* ── 图片/文件接收:下载到缓存目录 files 分区(按账号/发送人/日期隔离)并在会话留痕 ── */

/** 接收文件根:缓存目录 files 分区(随设置页「缓存目录」配置) */
function mediaRoot(): string {
  return getFilesRootDir()
}

/** 目录/文件名安全化(去路径分隔与空格,长度受限) */
function safeSeg(s: string, fallback: string): string {
  const t = (s || '')
    .trim()
    .replace(/[\\/:*?"<>|\r\n]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '')
  return (t || fallback).slice(0, 90)
}

/** 解析 image/file 消息 content(JSON) → {key, name} */
function mediaKeyOf(
  kind: 'image' | 'file',
  contentRaw: string | undefined
): { key: string; name?: string } | null {
  try {
    const obj = JSON.parse(contentRaw ?? '') as Record<string, unknown>
    const key = kind === 'image' ? String(obj.image_key ?? '') : String(obj.file_key ?? '')
    const name = typeof obj.file_name === 'string' ? obj.file_name : undefined
    return key ? { key, name } : null
  } catch {
    return null
  }
}

/** 文件扩展名推断:优先原文件名,失败按魔数(图片)/bin */
function extFromBuffer(buf: Buffer, kind: 'image' | 'file', name?: string): string {
  const fromName = name ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() || '' : ''
  if (kind === 'file' && /^[a-z0-9]{1,8}$/.test(fromName)) return fromName
  if (kind === 'image') {
    if (buf.length > 12) {
      const head = buf.subarray(0, 12).toString('latin1')
      if (buf[0] === 0x89 && buf[1] === 0x50) return 'png'
      if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg'
      if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'gif'
      if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp'
      if (head.startsWith('RIFF') && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
        return 'webp'
      }
    }
    return fromName || 'bin'
  }
  return fromName || 'bin'
}

/* ── "思考中"表情回应:收到消息即加表情,正式回复发出后移除 ── */
const thinkingReactions = new Map<string, string>()
/** 表情候选(个别 emoji_type 可能不被租户/群允许,依序尝试直到成功) */
const THINKING_EMOJIS = ['THINKING', 'THINK', 'HOURGLASS', 'SPARKLES', 'OK', 'SMILE']

async function tenantToken(rt: Runtime): Promise<string> {
  return await (
    rt.client as unknown as { tokenManager: { getTenantAccessToken(): Promise<string> } }
  ).tokenManager.getTenantAccessToken()
}

/** 给消息添加"思考中"表情回应;返回 reactionId(失败返回 null,不打扰流程) */
async function addThinkingReaction(rt: Runtime, messageId: string): Promise<string | null> {
  const key = `${rt.accountId}:${messageId}`
  if (thinkingReactions.has(key)) return thinkingReactions.get(key) ?? null
  try {
    const token = await tenantToken(rt)
    for (const emoji of THINKING_EMOJIS) {
      try {
        const res = await fetch(
          `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(
            messageId
          )}/reactions`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ reaction_type: { emoji_type: emoji } })
          }
        )
        if (!res.ok) continue
        const body = (await res.json()) as { data?: { reaction_id?: string } }
        const rid = body?.data?.reaction_id
        if (rid) {
          thinkingReactions.set(key, rid)
          return rid
        }
      } catch {
        /* 单个候选失败继续尝试下一个 */
      }
    }
  } catch (e) {
    imLog(
      rt.accountId,
      `添加思考表情失败(${messageId}):${e instanceof Error ? e.message : String(e)}`
    )
  }
  return null
}

/** 移除思考表情(回复已发出/结束调用;失败静默,残留表情无害) */
async function removeThinkingReaction(rt: Runtime, messageId: string): Promise<void> {
  const key = `${rt.accountId}:${messageId}`
  const rid = thinkingReactions.get(key)
  if (!rid) return
  thinkingReactions.delete(key)
  try {
    const token = await tenantToken(rt)
    const res = await fetch(
      `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(
        messageId
      )}/reactions/${encodeURIComponent(rid)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
    )
    if (!res.ok) {
      imLog(rt.accountId, `移除思考表情失败(${messageId}) http=${res.status};表情保留`)
    }
  } catch {
    /* 静默:残留表情可接受 */
  }
}

/** 下载飞书消息资源(im 消息资源接口),返回字节缓冲 */
async function downloadFeishuResource(
  rt: Runtime,
  messageId: string,
  fileKey: string,
  kind: 'image' | 'file'
): Promise<Buffer | null> {
  const token = await tenantToken(rt)
  const url = `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(
    messageId
  )}/resources/${encodeURIComponent(fileKey)}?type=${kind}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) {
    imLog(rt.accountId, `资源下载失败 msg=${messageId} key=${fileKey} http=${res.status}`)
    return null
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length === 0) {
    imLog(rt.accountId, `资源下载为空 msg=${messageId} key=${fileKey}`)
    return null
  }
  return buf
}

/**
 * 收到 image/file 消息:按 账号 → 飞书用户 → 日期 隔离落盘,
 * 并在该外部会话上下文补一条「对方发送了图片/文件」记录(供后续 AI 感知),不触发 AI 回复。
 */
async function handleInboundMedia(
  accountId: number,
  rt: Runtime,
  chatId: string,
  messageId: string,
  kind: 'image' | 'file',
  contentRaw: string | undefined,
  _senderIds: SenderIds,
  openId: string
): Promise<void> {
  try {
    const meta = mediaKeyOf(kind, contentRaw)
    if (!meta) {
      imLog(accountId, `跳过:媒体消息缺 key(${messageId})`)
      return
    }
    const buf = await downloadFeishuResource(rt, messageId, meta.key, kind)
    if (!buf) return
    // 单文件上限拦截:超限不落盘、不登记,并向发送者回执(避免数据膨胀)
    const cap = maxFileBytes()
    if (cap > 0 && buf.length > cap) {
      imLog(
        accountId,
        `拒收超大${kind === 'image' ? '图片' : '文件'} ${messageId} size=${buf.length} cap=${cap}`
      )
      await safeReply(rt, messageId, `⚠️ ${maxFileHint()}。`)
      return
    }
    const ext = extFromBuffer(buf, kind, meta.name)
    const now = new Date()
    const day = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
      now.getDate()
    ).padStart(2, '0')}`
    const dir = join(mediaRoot(), `acct-${accountId}`, `user-${safeSeg(openId, 'unknown')}`, day)
    await mkdir(dir, { recursive: true })
    const base = safeSeg(meta.name ?? (kind === 'image' ? 'image' : 'file'), kind)
    const file = join(dir, `${Date.now()}_${base}.${ext}`)
    await writeFile(file, buf)
    // 登记索引(渠道/账号/发送人/相对路径),供工作台文件管理与过期清理
    insertFileRecord({
      channel: 'feishu',
      accountId,
      messageId,
      senderId: openId,
      chatId,
      kind,
      fileName: (meta.name ?? `${base}.${ext}`).slice(0, 240),
      relPath: relative(mediaRoot(), file).replace(/\\/g, '/'),
      bytes: buf.length,
      createdAt: Date.now()
    })
    imLog(
      accountId,
      `已保存${kind === 'image' ? '图片' : '文件'} ${meta.name ?? ''}(${buf.length} B) -> ${file}`
    )
    // 对话感知:外部会话上下文补一条用户侧记录(不入 AI 生成,避免每次文件都烧 token)
    const sessionId = await createImSession(accountId, chatId, `${rt.name}·${chatId.slice(-8)}`)
    appendChatMessage(
      sessionId,
      'user',
      'text',
      kind === 'image'
        ? `[收到图片] ${meta.name ?? '未命名'}`
        : `[收到文件] ${meta.name ?? '未命名'}`,
      { imFile: true, saved: file, bytes: buf.length }
    )
    // 回执:让发送者确认机器人已收到(先前静默存档,用户误以为没响应)
    const label = meta.name ? `「${meta.name}」` : ''
    await safeReply(
      rt,
      messageId,
      `已收到${kind === 'image' ? '图片' : '文件'} ${label}(${fmtBytes(buf.length)}),已保存 ✓`
    )
  } catch (e) {
    imLog(
      accountId,
      `媒体接收异常(${messageId}):${e instanceof Error ? (e.stack ?? e.message) : String(e)}`
    )
    await safeReply(rt, messageId, '⚠️ 文件接收失败,请稍后重试或重新发送一次。')
  } finally {
    // 必须无条件清理:此前两条提前 return(缺 key / 超限)漏了这一步,
    // thinkingReactions Map 条目永久残留,且用户消息上的「思考中」表情不会撤
    void removeThinkingReaction(rt, messageId)
  }
}

/** 字节数 → 可读大小(飞书回执用) */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 串行 drain:逐个处理队列中的最新消息(取时即删,天然只留最新) */
async function drainInbound(sessionId: number, rt: Runtime): Promise<void> {
  for (;;) {
    const item = pendingQueue.get(sessionId)
    if (!item) return
    pendingQueue.delete(sessionId)
    // 上一轮引擎未结束时新消息已入队:等空闲再跑,避免忙碌报错刷屏
    const startedAt = Date.now()
    const idle = await waitIdle(rt.businessWxid, sessionId)
    if (!idle) {
      auditFinish(item.logId ?? null, { status: 'failed', error: '等待引擎空闲超时' })
      await safeReply(rt, item.messageId, '上一轮生成仍在进行,已超过等待上限,请稍后重试')
      void removeThinkingReaction(rt, item.messageId)
      continue
    }
    auditBegin(item.logId ?? null)
    const out = await runAiTurn(
      sessionId,
      rt.businessWxid,
      item.text,
      rt,
      item.messageId,
      item.logId ?? null,
      item.senderOpenId ?? ''
    )
    feishuConfirm.delete(String(sessionId))
    if (out === null) {
      auditFinish(item.logId ?? null, {
        status: 'failed',
        error: '生成超时(5 分钟)',
        elapsedMs: Date.now() - startedAt
      })
      await safeReply(rt, item.messageId, '处理超时(5 分钟),请稍后重试或直接在 AI 助手里查看')
      void removeThinkingReaction(rt, item.messageId)
      continue
    }
    auditFinish(item.logId ?? null, {
      status: 'done',
      result: out,
      replyLen: out.length,
      elapsedMs: Date.now() - startedAt
    })
    await safeReply(rt, item.messageId, out)
    // 回复已发出:撤掉"思考中"表情(回答完成)
    void removeThinkingReaction(rt, item.messageId)
  }
}

/**
 * 跑一轮 AI turn;wxid 为渠道绑定的业务账号(空=通用对话);
 * 返回要回复的文本(null = 超时/无输出);过程中聚合工具痕迹简报(⑤),
 * 高危工具(pending)由本会话用户在飞书内二次确认。
 */
async function runAiTurn(
  sessionId: number,
  businessWxid: string,
  text: string,
  rt: Runtime,
  replyMessageId: string,
  auditId: number | null = null,
  /** 发起人 open_id:审批卡片只允许他点按钮(空 = 不校验，沿用文本确认行为) */
  operatorOpenId = ''
): Promise<string | null> {
  return await new Promise<string | null>((resolve) => {
    let finished = false
    const tools = new Map<string, number>()
    const startedAt = Date.now()
    /** 中途进度回执:最多 2 条,避免刷屏(20s / 60s 各一次,且必须已经有工具调用) */
    let interimSent = 0
    const progressTimer = setInterval(() => {
      if (finished) return
      const elapsed = Date.now() - startedAt
      const thresholds = [20_000, 60_000]
      if (interimSent >= thresholds.length) return
      if (elapsed < thresholds[interimSent]) return
      if (tools.size === 0) return
      interimSent += 1
      const brief = [...tools.entries()]
        .map(([n, c]) => `${toolCnName(n)}${c > 1 ? `×${c}` : ''}`)
        .join('、')
      auditProgress(auditId, `已调用 ${brief}`)
      void safeReply(
        rt,
        replyMessageId,
        `⏳ 仍在处理(已 ${Math.round(elapsed / 1000)}s):已完成 ${brief};完成后会继续回你。`
      ).catch(() => {
        /* 中途回执失败不影响主流程 */
      })
    }, 5_000)
    const finish = (val: string | null): void => {
      if (finished) return
      finished = true
      feishuConfirm.delete(String(sessionId))
      clearTimeout(timer)
      clearInterval(progressTimer)
      unreg()
      resolve(val)
    }
    const timer = setTimeout(() => {
      imLog('ai', `会话 ${sessionId} 超时 5 分钟`)
      finish(null)
    }, 5 * 60_000)
    // sink 键需与 sendChatMessage 的事件 wxid 一致(绑定后为业务账号),否则收不到 done
    const unreg = registerEventSink(businessWxid, sessionId, (evt: AiChatEvent) => {
      if (finished) return
      if (evt.type === 'tool' && evt.toolStatus === 'pending' && evt.text) {
        // 引擎挂起等人工确认:在本会话内询问,用户答复后由 handleInbound 消费
        feishuConfirm.set(String(sessionId), { runId: evt.text, operatorOpenId })
        const card = approvalCard({
          toolName: evt.tool ? toolCnName(evt.tool) : '未知操作',
          args: evt.args ? clipForChannel(evt.args, 200) : '',
          runId: evt.text,
          operatorOpenId
        })
        const fallback = `⚠️ 需要你确认:智能体要执行「${
          evt.tool ? toolCnName(evt.tool) : '未知操作'
        }」${evt.args ? `\n参数:${clipForChannel(evt.args, 200)}` : ''}\n回复「确认」执行,回复「取消」拒绝。`
        void sendCardReply(rt, replyMessageId, card).catch(() => {
          // 卡片发不出去(权限/版本等)时退回文本确认,不让审批链断掉
          void safeReply(rt, replyMessageId, fallback).catch(() => {
            /* 发送失败由 safeReply 内部记录 */
          })
        })
        return
      }
      if (evt.type === 'tool' && evt.tool && evt.toolStatus) {
        if (evt.toolStatus === 'done' || evt.toolStatus === 'fail') {
          tools.set(evt.tool, (tools.get(evt.tool) ?? 0) + 1)
          auditProgress(
            auditId,
            [...tools.entries()]
              .map(([n, c]) => `${toolCnName(n)}${c > 1 ? `×${c}` : ''}`)
              .join('、')
          )
        }
        return
      }
      if (evt.type === 'done') {
        // 只取最后一条助手文本:此前读全量历史再 reverse 查找,长会话白读几千行
        const body = lastAssistantText(sessionId) ?? '(已生成,无文本内容)'
        // 过程简报:列出本回答依赖的工具查询(中文短名,重复计次)
        if (tools.size > 0) {
          const brief = [...tools.entries()]
            .map(([n, c]) => `${toolCnName(n)}${c > 1 ? `×${c}` : ''}`)
            .join('、')
          finish(`${body}\n\n—— 以上依据工具查询:${brief} 生成`)
        } else {
          finish(body)
        }
      } else if (evt.type === 'error') {
        finish(`⚠ ${clipForChannel(evt.text ?? '生成失败', 300)}`)
      } else if (evt.type === 'status' && evt.text === '已停止') {
        finish('已停止生成 ✅')
      }
    })
    void sendChatMessage({ wxid: businessWxid, chatId: sessionId, text })
      .then((res) => {
        if (!res.ok) {
          imLog('ai', `会话 ${sessionId} 发送失败:${res.error ?? ''}`)
          finish(`⚠ ${clipForChannel(res.error ?? '引擎发送失败', 300)}`)
        }
      })
      .catch((e) => {
        imLog('ai', `会话 ${sessionId} 引擎异常:${e instanceof Error ? e.message : String(e)}`)
        finish(`引擎异常:${clipForChannel(String(e instanceof Error ? e.message : e), 300)}`)
      })
  })
}

async function safeReply(rt: Runtime, messageId: string, text: string): Promise<void> {
  try {
    await sendTextReply(rt, messageId, text)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    imLog(rt.accountId, `回复发送失败(msg=${messageId}):${msg}`)
    // 常见:机器人无“发送消息”权限/未发布版本 → 给出可行动的提示
    if (/91002|permission|scope|Forbidden|10003/i.test(msg)) {
      setStatus(
        rt,
        rt.status,
        rt.statusText,
        new Error(`回复失败,疑似权限问题:${msg.slice(0, 120)}`)
      )
    }
  }
}

/** 原消息回复一张交互卡片(工具审批按钮用);失败由调用方回落文本确认 */
async function sendCardReply(
  rt: Runtime,
  messageId: string,
  card: Record<string, unknown>
): Promise<void> {
  await rt.client.im.message.reply({
    path: { message_id: messageId },
    data: { msg_type: 'interactive', content: JSON.stringify(card) }
  })
}

/** 原消息回复:先做 Markdown → 飞书可读纯文本降级,再长文本分片 */
async function sendTextReply(rt: Runtime, messageId: string, text: string): Promise<void> {
  const plain = feishuPlainText(text)
  const chunks: string[] = []
  let rest = plain
  while (rest.length > 0) {
    chunks.push(rest.slice(0, 3000))
    rest = rest.slice(3000)
  }
  const list = chunks.length > 0 ? chunks : ['(空)']
  imLog(rt.accountId, `回发 ${list.length} 片 共 ${plain.length} 字 -> ${messageId}`)
  for (const chunk of list) {
    await rt.client.im.message.reply({
      path: { message_id: messageId },
      data: { msg_type: 'text', content: JSON.stringify({ text: chunk }) }
    })
  }
}
