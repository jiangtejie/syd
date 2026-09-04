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
 * - 回复走原消息 reply;长文本按 3000 字分片;错误与停止状态也会回传。
 */

interface ImReceiveEvent {
  schema?: unknown
  event?: {
    message?: {
      message_id?: string
      chat_id?: string
      chat_type?: string
      message_type?: string
      content?: string
      mentions?: Array<{ key?: string; id?: Record<string, string> }>
    }
    sender?: { sender_type?: string }
  }
}

interface MinimalWsc {
  start: () => void
  close?: () => void
  on: (event: string, cb: (data: unknown) => void) => void
}

interface MinimalLarkClient {
  im: {
    message: {
      reply: (opts: {
        path: { message_id: string }
        data: { msg_type: 'text'; content: string }
      }) => Promise<unknown>
    }
  }
}

interface Runtime {
  appId: string
  wsc: MinimalWsc
  client: MinimalLarkClient
  name: string
  status: 'connected' | 'connecting' | 'error'
  statusText: string
  lastError?: string
}

const runtimes = new Map<number, Runtime>()

export function getImStatus(accountId: number): { status?: string; statusText?: string } {
  const r = runtimes.get(accountId)
  return r ? { status: r.status, statusText: r.lastError ?? r.statusText } : {}
}

/** 启用一个飞书账号(幂等) */
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
  if (!appId || !appSecret) return { ok: false, error: '缺少应用凭证' }
  try {
    const client = new lark.Client({
      appId,
      appSecret,
      appType: lark.AppType.SelfBuild
    }) as unknown as MinimalLarkClient
    const wsc = new lark.WSClient({
      appId,
      appSecret,
      loggerLevel: lark.LoggerLevel.info
    }) as unknown as MinimalWsc
    const rt: Runtime = {
      appId,
      wsc,
      client,
      name,
      status: 'connecting',
      statusText: '连接中…'
    }
    runtimes.set(accountId, rt)

    wsc.on('im.message.receive_v1', (data) => {
      const d = data as ImReceiveEvent
      const msg = d?.event?.message
      if (!msg?.message_id || !msg.chat_id) return
      if (msg.message_type !== 'text') return // 一期仅文本
      if (d?.event?.sender?.sender_type && d.event.sender.sender_type !== 'user') return
      // 准入:私聊直接响应;群聊需要被 @ 本应用
      if (msg.chat_type !== 'p2p') {
        const mentionedApp = (msg.mentions ?? []).some((m) => {
          const id = m.id ?? {}
          return id.app_id === appId || Object.keys(id).length === 0
        })
        if (!mentionedApp) return
      }
      let text = ''
      try {
        const content = JSON.parse(msg.content ?? '{}') as { text?: string }
        text = (content.text ?? '')
          .trim()
          .replace(/@_user_\d+/g, '')
          .trim()
      } catch {
        return
      }
      if (!text) return
      void handleInbound(accountId, rt, msg.chat_id, msg.message_id, text).catch((e) => {
        void sendTextReply(
          rt,
          msg.message_id!,
          `处理失败:${e instanceof Error ? e.message : String(e)}`
        )
      })
    })

    wsc.start()
    rt.status = 'connected'
    rt.statusText = '已连接(WebSocket 长连接)'
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    runtimes.set(accountId, {
      appId,
      wsc: null as unknown as MinimalWsc,
      client: null as unknown as MinimalLarkClient,
      name,
      status: 'error',
      statusText: msg,
      lastError: msg
    })
    return { ok: false, error: msg }
  }
}

export function stopFeishuAccount(accountId: number): void {
  const rt = runtimes.get(accountId)
  if (rt) {
    try {
      rt.wsc.close?.()
    } catch {
      /* ignore */
    }
    runtimes.delete(accountId)
  }
}

export function stopAllFeishu(): void {
  for (const id of [...runtimes.keys()]) stopFeishuAccount(id)
}

async function handleInbound(
  accountId: number,
  rt: Runtime,
  chatId: string,
  replyMessageId: string,
  text: string
): Promise<void> {
  // 外部聊天 → 本地会话(幂等)
  const sessionId = await createImSession(accountId, chatId, `${rt.name}·${chatId.slice(-8)}`)

  // 忙碌保护:同会话已有 run 时,引擎会返回“正在生成中”错误,这里直接提示
  let finished = false
  const unregister = registerEventSink('', sessionId, (evt: AiChatEvent) => {
    if (evt.type === 'done') {
      finished = true
      const rows = listChatMessages(sessionId)
      const last = [...rows].reverse().find((m) => m.role === 'assistant' && m.kind === 'text')
      if (last?.content) void sendTextReply(rt, replyMessageId, last.content)
      else void sendTextReply(rt, replyMessageId, '已生成(无内容)')
    } else if (evt.type === 'error') {
      finished = true
      void sendTextReply(rt, replyMessageId, `⚠ ${evt.text ?? '生成失败'}`)
    } else if (evt.type === 'status' && evt.text === '已停止') {
      finished = true
      void sendTextReply(rt, replyMessageId, '已停止生成')
    }
  })
  try {
    const res = await sendChatMessage({ wxid: '', chatId: sessionId, text })
    if (!res.ok) {
      void sendTextReply(rt, replyMessageId, res.error ?? '发送失败')
      return
    }
    // 等待异步 turn 结束(sink 触发 finished)
    const deadline = Date.now() + 120_000
    while (!finished && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150))
    }
  } finally {
    unregister()
  }
}

/** 原消息回复,长文本分片 */
async function sendTextReply(rt: Runtime, messageId: string, text: string): Promise<void> {
  const chunks: string[] = []
  let rest = text.trim()
  while (rest.length > 0) {
    chunks.push(rest.slice(0, 3000))
    rest = rest.slice(3000)
  }
  for (const chunk of chunks.length > 0 ? chunks : ['(空)']) {
    await rt.client.im.message.reply({
      path: { message_id: messageId },
      data: { msg_type: 'text', content: JSON.stringify({ text: chunk }) }
    })
  }
}
