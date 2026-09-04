import { appendFileSync, existsSync, mkdirSync, statSync, truncateSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import * as lark from '@larksuiteoapi/node-sdk'
import { getImAccountConfig } from '../../db/repos/imRepo'
import { listChatMessages } from '../../db/repos/chatRepo'
import { createImSession } from './sessionBridge'
import { registerEventSink, sendChatMessage } from '../ai/chat/service'
import { openSecret } from '../secrets'
import type { AiChatEvent } from '../../../shared/types'

/**
 * 飞书机器人通道(IM 一期)。
 * - 官方 WebSocket 长连接收消息;仅响应 私聊(p2p)或群内被 @ 本应用 的文本;
 * - 每个外部聊天自动映射一个本地 AI 会话(独立上下文,复用记忆/工具/ReAct 引擎);
 * - 回复走原消息 reply;长文本按 3000 字分片;
 * - 事件处理立即 ack(长连接 3s 内需应答,超时平台会重推),AI 生成异步进行,结果用
 *   REST API 回发(与长连接状态无关),同一 message_id 去重防平台重推造成双回复。
 *
 * 注意:必须使用当前 SDK 的 WSClient API —— 事件通过 EventDispatcher 注册并传入
 * start({ eventDispatcher }),WSClient 没有 on() 方法(旧实现 wsc.on() 运行时抛错,
 * 导致“看似已启用其实从未建立长连接”,即历史 Bug)。
 */

/** 磁盘日志(打包后无控制台,用于远程排查) */
function imLog(accountId: number | string, text: string): void {
  try {
    const dir = join(app.getPath('userData'), 'logs')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const file = join(dir, 'im.log')
    if (existsSync(file)) {
      try {
        if (statSync(file).size > 512 * 1024) truncateSync(file, 0)
      } catch {
        /* ignore */
      }
    }
    const line = `[${new Date().toISOString()}] [acct=${accountId}] ${text}\n`
    appendFileSync(file, line, 'utf-8')
  } catch {
    /* 日志失败不影响功能 */
  }
  try {
    console.log(`[im] acct=${accountId} ${text}`)
  } catch {
    /* ignore */
  }
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
  client: {
    im: {
      message: {
        reply: (opts: {
          path: { message_id: string }
          data: { msg_type: 'text'; content: string }
        }) => Promise<unknown>
      }
    }
  }
  wsc: { start: (p: { eventDispatcher: unknown }) => Promise<void>; close?: () => void } | null
  name: string
  /** 回复内容是否带账号标识前缀(【账号名称】) */
  replyTag: boolean
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

export function getImStatus(accountId: number): { status?: string; statusText?: string } {
  const r = runtimes.get(accountId)
  return r ? { status: r.status, statusText: r.lastError ?? r.statusText } : {}
}

/** 保存/改名后同步运行期展示名与回复前缀开关(不必重启连接) */
export function syncFeishuMeta(accountId: number, name: string): void {
  const rt = runtimes.get(accountId)
  if (!rt) return
  const cfg = getImAccountConfig(accountId)
  if (name?.trim()) rt.name = name.trim()
  rt.replyTag = cfg.replyTag !== false
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

/**
 * 事件载荷两种可能形态都兼容:
 * - 长连接(当前 SDK):EventDispatcher 解包后直接是事件体 { sender, message, ... };
 * - webhook 信封 { schema, header, event }:取 event 字段。
 */
function extractMessage(data: unknown): { msg?: ImMessage; senderType?: string } {
  const d = (data ?? {}) as {
    event?: unknown
    sender?: { sender_type?: string }
    message?: ImMessage
  }
  const body = (d.event && typeof d.event === 'object' ? d.event : d) as {
    message?: ImMessage
    sender?: { sender_type?: string }
  }
  return { msg: body?.message, senderType: body?.sender?.sender_type }
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
      client,
      wsc: null,
      name,
      replyTag: cfg.replyTag !== false,
      status: 'connecting',
      statusText: '连接中…',
      recent: new Map()
    }
    runtimes.set(accountId, rt)
    imLog(accountId, `开始建立飞书长连接(appId=${appId})`)

    // 事件处理:只做准入与去重,随即异步跑 AI(handler 必须快速返回,3s 内 ack)
    const onReceive = (data: unknown): void => {
      const { msg, senderType } = extractMessage(data)
      if (!msg?.message_id || !msg.chat_id) {
        imLog(
          accountId,
          `跳过:载荷缺少 message_id/chat_id ${JSON.stringify(data ?? {}).slice(0, 200)}`
        )
        return
      }
      if (msg.message_type !== 'text') {
        imLog(accountId, `跳过:非文本消息 ${msg.message_type ?? ''}(${msg.message_id})`)
        return
      }
      if (senderType && senderType !== 'user') {
        imLog(accountId, `跳过:非用户消息 sender_type=${senderType}(${msg.message_id})`)
        return
      }
      // 准入:私聊直接响应;群聊需要被 @ 本应用
      if (msg.chat_type !== 'p2p') {
        const mentionedApp = (msg.mentions ?? []).some((m) => {
          const id = m.id ?? {}
          return id.app_id === appId || Object.keys(id).length === 0
        })
        if (!mentionedApp) {
          imLog(accountId, `跳过:群聊未@本应用(${msg.message_id})`)
          return
        }
      }
      const text = parseText(msg.content)
      if (!text) {
        imLog(accountId, `跳过:文本为空(${msg.message_id})`)
        return
      }
      if (isDuplicate(rt, msg.message_id)) {
        imLog(accountId, `跳过:重复推送 ${msg.message_id}`)
        return
      }
      imLog(accountId, `收到消息 ${msg.message_id} type=${msg.chat_type} len=${text.length}`)
      void handleInbound(accountId, rt, msg.chat_id!, msg.message_id!, text)
    }
    dispatcher.register({ 'im.message.receive_v1': onReceive })

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

/** 外部聊天 → 本地会话 → AI 生成 → 结果回发 */
async function handleInbound(
  accountId: number,
  rt: Runtime,
  chatId: string,
  replyMessageId: string,
  text: string
): Promise<void> {
  try {
    const sessionId = await createImSession(accountId, chatId, `${rt.name}·${chatId.slice(-8)}`)
    const out = await runAiTurn(sessionId, text)
    if (out === null) {
      await safeReply(rt, replyMessageId, '处理超时(5 分钟),请稍后重试或直接在 AI 助手里查看')
      return
    }
    await safeReply(rt, replyMessageId, out)
  } catch (e) {
    imLog(accountId, `处理入站消息异常:${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
    await safeReply(rt, replyMessageId, `处理失败:${e instanceof Error ? e.message : String(e)}`)
  }
}

/** 跑一轮 AI turn;返回要回复的文本(null = 超时/无输出) */
async function runAiTurn(sessionId: number, text: string): Promise<string | null> {
  return await new Promise<string | null>((resolve) => {
    let finished = false
    const finish = (val: string | null): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      unreg()
      resolve(val)
    }
    const timer = setTimeout(() => {
      imLog('ai', `会话 ${sessionId} 超时 5 分钟`)
      finish(null)
    }, 5 * 60_000)
    const unreg = registerEventSink('', sessionId, (evt: AiChatEvent) => {
      if (finished) return
      if (evt.type === 'done') {
        const rows = listChatMessages(sessionId)
        const last = [...rows].reverse().find((m) => m.role === 'assistant' && m.kind === 'text')
        finish(last?.content ?? '(已生成,无文本内容)')
      } else if (evt.type === 'error') {
        finish(`⚠ ${evt.text ?? '生成失败'}`)
      } else if (evt.type === 'status' && evt.text === '已停止') {
        finish('已停止生成')
      }
    })
    void sendChatMessage({ wxid: '', chatId: sessionId, text })
      .then((res) => {
        if (!res.ok) {
          imLog('ai', `会话 ${sessionId} 发送失败:${res.error ?? ''}`)
          finish(res.error ?? '引擎发送失败')
        }
      })
      .catch((e) => {
        imLog('ai', `会话 ${sessionId} 引擎异常:${e instanceof Error ? e.message : String(e)}`)
        finish(`引擎异常:${e instanceof Error ? e.message : String(e)}`)
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

/** 原消息回复,长文本分片;开启账号标识时首片带【账号名称】前缀 */
async function sendTextReply(rt: Runtime, messageId: string, text: string): Promise<void> {
  const chunks: string[] = []
  let rest = (text ?? '').trim()
  while (rest.length > 0) {
    chunks.push(rest.slice(0, 3000))
    rest = rest.slice(3000)
  }
  const list = chunks.length > 0 ? chunks : ['(空)']
  if (rt.replyTag && rt.name.trim()) {
    const tag = `【${rt.name.trim().slice(0, 20)}】`
    if (!list[0].startsWith(tag)) list[0] = `${tag} ${list[0]}`
  }
  imLog(rt.accountId, `回发 ${list.length} 片 共 ${(text ?? '').length} 字 -> ${messageId}`)
  for (const chunk of list) {
    await rt.client.im.message.reply({
      path: { message_id: messageId },
      data: { msg_type: 'text', content: JSON.stringify({ text: chunk }) }
    })
  }
}
