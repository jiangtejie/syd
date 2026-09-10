import { BrowserWindow } from 'electron'
import { getImAccountConfig, saveImAccount, listMappedSessionIds } from '../../db/repos/imRepo'
import { appendChatMessage, listChatMessages } from '../../db/repos/chatRepo'
import { createLogger } from '../logging'
import { createImSession } from './sessionBridge'
import { parseCapTier, setSessionCapTier, type CapTier } from '../ai/cap/tiers'
import {
  confirmToolRun,
  isChatRunning,
  registerEventSink,
  sendChatMessage,
  stopChat
} from '../ai/chat/service'
import { ensureBoundBusinessMounts } from '../ai/cap/mounts'
import { openSecret, sealSecret } from '../secrets'
import QRCode from 'qrcode'

/**
 * 微信 ClawBot(官方 iLink)通道。
 * - 配置:bot_token + 网关(默认 https://ilinkai.weixin.qq.com)
 * - 长轮询 POST /ilink/bot/getupdates({get_updates_buf}) 收消息,
 *   回复 POST /ilink/bot/sendmessage 且必须原样带回 context_token
 * - 认证头:AuthorizationType=ilink_bot_token / X-WECHAT-UIN=base64(随机uint32) / Bearer token
 * - 外部用户 → 本地 AI 会话(独立上下文);可选绑定业务账号(与飞书一致)
 */

const clawLog = createLogger('im')
const DEFAULT_BASE = 'https://ilinkai.weixin.qq.com'

interface Runtime {
  accountId: number
  name: string
  baseUrl: string
  token: string
  businessWxid: string
  allowUsers: string[]
  /** 指令权限名单(用户标识 → 档位) */
  permissions: Record<string, string>
  buffer: string
  controller: AbortController | null
  timer: ReturnType<typeof setInterval> | null
  polling: boolean
  status: 'connected' | 'connecting' | 'error'
  statusText: string
  lastError?: string
}

const runtimes = new Map<number, Runtime>()

function parseAllow(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/[,\s，]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function imLog(accountId: number | string, text: string): void {
  clawLog.info(`${accountId === 'ai' ? 'ai' : `acct=${accountId}`} ${text}`)
}

function setStatus(rt: Runtime, status: Runtime['status'], text: string, err?: unknown): void {
  rt.status = status
  rt.statusText = text
  rt.lastError = err instanceof Error ? err.message : err ? String(err) : undefined
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('cs:im:status', {
      accountId: rt.accountId,
      status,
      statusText: rt.lastError ?? text,
      at: Date.now()
    })
  }
  imLog(rt.accountId, `状态变更 -> ${status}: ${rt.lastError ?? text}`)
}

/** 随机 uint32 → base64(X-WECHAT-UIN) */
function randomUin(): string {
  const n = Math.floor(Math.random() * 0xffffffff)
  return Buffer.from(String(n)).toString('base64')
}

async function api(
  rt: Runtime,
  path: string,
  body: unknown
): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }> {
  try {
    const res = await fetch(`${rt.baseUrl.replace(/\/+$/, '')}/ilink/bot/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        AuthorizationType: 'ilink_bot_token',
        'X-WECHAT-UIN': randomUin(),
        Authorization: `Bearer ${rt.token}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000)
    })
    const data = (await res.json()) as { ret?: number; err_msg?: string; [k: string]: unknown }
    if (!res.ok || data.ret !== 0) {
      return {
        ok: false,
        error: `HTTP ${res.status} ret=${String(data.ret ?? '?')} ${data.err_msg ?? ''}`.trim()
      }
    }
    return { ok: true, data }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function sendText(
  rt: Runtime,
  toUserId: string,
  contextToken: string,
  text: string
): Promise<boolean> {
  const plain = text ?? ''
  const chunks: string[] = []
  let rest = plain
  while (rest.length > 0) {
    chunks.push(rest.slice(0, 2000))
    rest = rest.slice(2000)
  }
  const list = chunks.length > 0 ? chunks : ['(空)']
  for (const chunk of list) {
    const r = await api(rt, 'sendmessage', {
      msg: {
        to_user_id: toUserId,
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: [{ type: 1, text_item: { text: chunk } }]
      }
    })
    if (!r.ok) {
      imLog(rt.accountId, `ClawBot 发送失败(${toUserId}):${r.error}`)
      return false
    }
  }
  return true
}

/** 文本抽取:取 item_list 中所有文本拼接;媒体消息返回其类型标签(图片/文件/语音/视频/其它) */
function extractText(msg: { item_list?: Array<Record<string, unknown>> }): {
  text: string
  mediaLabel?: string
} {
  const kinds: Record<number, string> = { 2: '图片', 3: '语音', 4: '文件', 5: '视频' }
  const textParts: string[] = []
  let media: string | undefined
  for (const it of msg.item_list ?? []) {
    const type = Number(it.type ?? 0)
    const textItem = it.text_item as { text?: string } | undefined
    if (type === 1 && typeof textItem?.text === 'string' && textItem.text.trim()) {
      textParts.push(textItem.text)
    } else if (type in kinds && !media) {
      media = kinds[type]
    }
  }
  return { text: textParts.join(' ').trim(), mediaLabel: media }
}

const STOP_WORDS = new Set(['停止', '停', 'stop', '中止'])
const CONFIRM_YES = new Set(['确认', '确认发送', '同意', '同意发送', '确认执行', 'yes', 'ok'])
const CONFIRM_NO = new Set(['取消', '拒绝', '不同意', '拒绝发送', '不发送', 'no', 'cancel'])

/** 每账号待办:会话级 最新文本(同用户多消息只保留最新) + 待确认工具 runId */
const pendingQueue = new Map<
  string,
  { accountId: number; toUserId: string; contextToken: string; text: string }
>()
const confirmBySession = new Map<
  string,
  { runId: string; toUserId: string; contextToken: string }
>()

async function handleInbound(rt: Runtime, msg: Record<string, unknown>): Promise<void> {
  const fromUserId = String(msg.from_user_id ?? '')
  const contextToken = String(msg.context_token ?? '')
  if (!fromUserId || !contextToken) return
  const msgType = Number(msg.message_type ?? 0)
  // message_type != 1 视为 bot 自身消息/系统消息
  if (msgType !== 1) return
  const { text, mediaLabel } = extractText(msg as { item_list?: Array<Record<string, unknown>> })
  if (!text && !mediaLabel) return

  // 工具确认答复
  const pending = confirmBySession.get(fromUserId)
  if (pending) {
    const norm = text.trim().toLowerCase()
    if (CONFIRM_YES.has(norm) || CONFIRM_NO.has(norm)) {
      confirmBySession.delete(fromUserId)
      const ok = CONFIRM_YES.has(norm)
      confirmToolRun(pending.runId, ok)
      void sendText(rt, fromUserId, contextToken, ok ? '已确认,继续执行…' : '已取消本次操作')
      return
    }
  }
  // 停止指令
  if (STOP_WORDS.has(text.trim().toLowerCase())) {
    const sid = await createImSession(
      rt.accountId,
      fromUserId,
      `${rt.name}·${fromUserId.slice(0, 10)}`
    )
    if (isChatRunning(rt.businessWxid, sid)) {
      stopChat(rt.businessWxid, sid)
      void sendText(rt, fromUserId, contextToken, '已停止生成 ✅')
      return
    }
  }
  if (!text) {
    // 纯媒体:留痕并回执(暂不支持解析内容)
    const sid = await createImSession(
      rt.accountId,
      fromUserId,
      `${rt.name}·${fromUserId.slice(0, 10)}`
    )
    appendChatMessage(sid, 'user', 'text', `[收到${mediaLabel}] (暂不支持内容读取)`)
    void sendText(
      rt,
      fromUserId,
      contextToken,
      `已收到${mediaLabel ?? '消息'} ✓(我目前只能处理文字,请用文字说明需求)`
    )
    return
  }
  pendingQueue.set(fromUserId, {
    accountId: rt.accountId,
    toUserId: fromUserId,
    contextToken,
    text
  })
  void drainAccount(rt)
}

async function runTurnAndReply(
  rt: Runtime,
  item: { toUserId: string; contextToken: string; text: string }
): Promise<void> {
  const sessionId = await sessionOf(rt, item.toUserId)
  const out = await new Promise<string | null>((resolve) => {
    let done = false
    const finish = (v: string | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      unreg()
      resolve(v)
    }
    const timer = setTimeout(() => finish(null), 5 * 60_000)
    const unreg = registerEventSink(rt.businessWxid, sessionId, (evt) => {
      if (done) return
      if (evt.type === 'tool' && evt.toolStatus === 'pending' && evt.text) {
        confirmBySession.set(item.toUserId, {
          runId: evt.text,
          toUserId: item.toUserId,
          contextToken: item.contextToken
        })
        void sendText(
          rt,
          item.toUserId,
          item.contextToken,
          `⚠️ 需要你确认:智能体要执行「${evt.tool}」${
            evt.args ? `\n参数:${String(evt.args).slice(0, 200)}` : ''
          }\n回复「确认」执行,回复「取消」拒绝。`
        ).catch(() => undefined)
        return
      }
      if (evt.type === 'tool' && evt.tool && evt.toolStatus) return
      if (evt.type === 'done') {
        confirmBySession.delete(item.toUserId)
        const rows = listChatMessages(sessionId)
        const last = [...rows].reverse().find((m) => m.role === 'assistant' && m.kind === 'text')
        finish(last?.content?.trim() || '(已生成,无文本内容)')
      } else if (evt.type === 'error') {
        confirmBySession.delete(item.toUserId)
        finish(`⚠ ${String(evt.text ?? '生成失败').slice(0, 500)}`)
      } else if (evt.type === 'status' && evt.text === '已停止') {
        confirmBySession.delete(item.toUserId)
        finish('已停止生成 ✅')
      }
    })
    void sendChatMessage({ wxid: rt.businessWxid, chatId: sessionId, text: item.text })
      .then((res) => {
        if (!res.ok) finish(`⚠ ${String(res.error ?? '发送失败').slice(0, 500)}`)
      })
      .catch((e) => finish(`引擎异常:${e instanceof Error ? e.message : String(e)}`))
  })
  if (out !== null) await sendText(rt, item.toUserId, item.contextToken, out)
}

async function drainAccount(rt: Runtime): Promise<void> {
  while (true) {
    let item: { toUserId: string; contextToken: string; text: string } | undefined
    for (const [k, v] of pendingQueue) {
      if (v.accountId === rt.accountId) {
        item = { toUserId: v.toUserId, contextToken: v.contextToken, text: v.text }
        pendingQueue.delete(k)
        break
      }
    }
    if (!item) break
    const sid = await sessionOf(rt, item.toUserId)
    // 上一轮引擎仍忙:等空闲(最多 5 分钟),避免并发问同一会话
    let waited = 0
    while (isChatRunning(rt.businessWxid, sid) && waited < 300) {
      await new Promise((r) => setTimeout(r, 1000))
      waited += 1
    }
    if (isChatRunning(rt.businessWxid, sid)) {
      void sendText(rt, item.toUserId, item.contextToken, '上一轮生成仍在进行,请稍后再试。')
      continue
    }
    await runTurnAndReply(rt, item)
  }
}

async function sessionOf(rt: Runtime, userId: string): Promise<number> {
  const sid = await createImSession(rt.accountId, userId, `${rt.name}·${userId.slice(0, 10)}`)
  // 与飞书渠道一致:外部渠道默认只读;白名单内默认可写;权限名单可指定 admin(含代发微信)
  const tier: CapTier =
    parseCapTier(rt.permissions[userId]) ??
    (rt.allowUsers.length === 0 || rt.allowUsers.includes(userId) ? 'operator' : 'viewer')
  setSessionCapTier(sid, tier)
  return sid
}

async function pollOnce(rt: Runtime): Promise<void> {
  const r = await api(rt, 'getupdates', {
    get_updates_buf: rt.buffer,
    base_info: { channel_version: '1.0.2' }
  })
  if (!r.ok) {
    setStatus(rt, 'error', `ClawBot 长轮询失败(将自动重试):${r.error}`)
    return
  }
  const msgs = Array.isArray(r.data?.msgs) ? (r.data?.msgs as Array<Record<string, unknown>>) : []
  const buf = r.data?.get_updates_buf
  if (typeof buf === 'string' && buf) rt.buffer = buf
  if (rt.status !== 'connected') setStatus(rt, 'connected', 'ClawBot 已连接(长轮询就绪)')
  for (const m of msgs) {
    await handleInbound(rt, m)
  }
  await drainAccount(rt)
}

/** 启动一个 ClawBot 账号(幂等) */
export async function startWechatClawAccount(
  accountId: number,
  name: string
): Promise<{ ok: boolean; error?: string }> {
  const existing = runtimes.get(accountId)
  if (existing) return { ok: true }
  const cfg = getImAccountConfig(accountId)
  const token = openSecret(cfg.clawToken)
  if (!token) return { ok: false, error: '缺少 ClawBot bot_token(加密存储),请编辑账号重新填写' }
  const rt: Runtime = {
    accountId,
    name,
    baseUrl: (cfg.baseUrl ?? '').trim() || DEFAULT_BASE,
    token,
    businessWxid: (cfg.wxid ?? '').trim(),
    allowUsers: parseAllow(cfg.allowUsers),
    permissions: cfg.permissions ?? {},
    buffer: '',
    controller: null,
    timer: null,
    polling: false,
    status: 'connecting',
    statusText: '连接中…'
  }
  runtimes.set(accountId, rt)
  imLog(
    accountId,
    `开始 ClawBot 长轮询(baseUrl=${rt.baseUrl}${
      rt.businessWxid ? `,绑定业务账号=${rt.businessWxid}` : ''
    })`
  )
  if (rt.businessWxid) {
    try {
      for (const sid of listMappedSessionIds(accountId)) ensureBoundBusinessMounts(sid)
    } catch (e) {
      imLog(accountId, `补齐映射会话能力失败:${e instanceof Error ? e.message : String(e)}`)
    }
  }
  rt.controller = new AbortController()
  const tick = (): void => {
    if (rt.polling) return // 上一次长轮询未结束(HTTP 最长 45s)时跳过,防并发双轮询
    rt.polling = true
    void pollOnce(rt)
      .catch((e) => {
        imLog(rt.accountId, `轮询异常:${e instanceof Error ? e.message : String(e)}`)
      })
      .finally(() => {
        rt.polling = false
      })
  }
  tick()
  rt.timer = setInterval(tick, 3000) // 兜底:异常退出后尽快再拉起
  return { ok: true }
}

export function stopWechatClawAccount(accountId: number): void {
  const rt = runtimes.get(accountId)
  if (rt) {
    rt.controller?.abort()
    if (rt.timer) clearInterval(rt.timer)
    runtimes.delete(accountId)
    imLog(accountId, 'ClawBot 已停用/关闭')
  }
}

export function stopAllWechatClaw(): void {
  for (const id of [...runtimes.keys()]) stopWechatClawAccount(id)
}

export function getWechatClawStatus(accountId: number): { status?: string; statusText?: string } {
  const r = runtimes.get(accountId)
  return r ? { status: r.status, statusText: r.lastError ?? r.statusText } : {}
}

/* ══════════ 扫码绑定:get_bot_qrcode → 轮询扫码 → 主进程自动建号(渲染端不见 token) ══════════ */

interface QrSession {
  qr: string
  baseUrl: string
  name: string
  wxid?: string
  allowUsers?: string
  token?: string
  /** 并发轮询去重:扫码确认后只建号一次 */
  created?: Promise<number | null>
  at: number
}

const qrSessions = new Map<string, QrSession>()
let qrSeq = 0

export async function clawQrStart(opts: {
  name: string
  baseUrl?: string
  wxid?: string
  allowUsers?: string
}): Promise<{ ok: boolean; key?: string; qrImg?: string; qrUrl?: string; error?: string }> {
  const baseUrl = (opts.baseUrl ?? '').trim() || DEFAULT_BASE
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/ilink/bot/get_bot_qrcode?bot_type=3`, {
      signal: AbortSignal.timeout(20_000),
      headers: { 'iLink-App-ClientVersion': '1' }
    })
    const data = (await res.json()) as Record<string, unknown>
    const qr = String(data.qrcode ?? '')
    if (!res.ok || !qr) {
      return {
        ok: false,
        error:
          `获取二维码失败 HTTP ${res.status} ${String(data.err_msg ?? data.message ?? '')}`.trim()
      }
    }
    const key = `clawqr-${Date.now()}-${++qrSeq}`
    qrSessions.set(key, {
      qr,
      baseUrl,
      name: (opts.name ?? '').trim() || '微信 ClawBot',
      wxid: (opts.wxid ?? '').trim() || undefined,
      allowUsers: (opts.allowUsers ?? '').trim() || undefined,
      at: Date.now()
    })
    for (const [k, s] of qrSessions) if (Date.now() - s.at > 3 * 60_000) qrSessions.delete(k)
    // 官方返回 qrcode_img_content 是「二维码内容(URL 字符串)」而非图片字节,
    // 官方/社区实现均为取该字符串本地编码成二维码(如 Python 版 qr.add_data(qrcode_img_content))
    const rawImg = data.qrcode_img_content ?? data.qr_img ?? data.img_content ?? data.qrcode_img
    let qrImg: string | undefined
    let qrUrl: string | undefined
    if (typeof rawImg === 'string' && rawImg) {
      if (rawImg.startsWith('data:image')) {
        qrImg = rawImg
      } else if (/^https?:\/\//i.test(rawImg)) {
        qrUrl = rawImg
        try {
          qrImg = await QRCode.toDataURL(rawImg, { width: 560, margin: 2 })
        } catch (e) {
          clawLog.warn(`二维码本地编码失败(将回退到链接):${e instanceof Error ? e.message : e}`)
        }
      } else if (!/[:/]/.test(rawImg)) {
        // 兼容部分网关直接下发纯 base64 图片字节的情况
        qrImg = `data:image/png;base64,${rawImg}`
      } else {
        qrUrl = rawImg
        try {
          qrImg = await QRCode.toDataURL(rawImg, { width: 560, margin: 2 })
        } catch (e) {
          clawLog.warn(`二维码本地编码失败(将回退到链接):${e instanceof Error ? e.message : e}`)
        }
      }
    }
    qrUrl = qrUrl ?? (typeof data.url === 'string' ? data.url : undefined)
    return { ok: true, key, qrImg, qrUrl }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function clawQrPoll(key: string): Promise<{
  ok: boolean
  status: 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'error'
  accountId?: number
  error?: string
}> {
  const s = qrSessions.get(key)
  if (!s) return { ok: false, status: 'expired', error: '二维码会话已失效,请重新获取' }
  // 已有建号在途(并发轮询):直接等它完成,避免重复建号
  if (s.created) {
    const accountId = await s.created
    qrSessions.delete(key)
    if (accountId === null) return { ok: false, status: 'error', error: '建号失败,请重试' }
    return { ok: true, status: 'confirmed', accountId }
  }
  try {
    const res = await fetch(
      `${s.baseUrl.replace(/\/+$/, '')}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(s.qr)}`,
      {
        signal: AbortSignal.timeout(15_000),
        headers: { 'iLink-App-ClientVersion': '1' }
      }
    )
    const data = (await res.json()) as Record<string, unknown>
    if (!res.ok) {
      return {
        ok: false,
        status: 'error',
        error: `HTTP ${res.status} ${String(data.err_msg ?? data.message ?? '')}`.trim()
      }
    }
    const status = String(data.status ?? '')
    if (status === 'confirmed') {
      if (!s.created) {
        if (!s.token) {
          const token = String(data.bot_token ?? '')
          if (!token) return { ok: false, status: 'error', error: '已确认但未返回 bot_token' }
          s.token = token
        }
        if (typeof data.baseurl === 'string' && data.baseurl) s.baseUrl = data.baseurl
        s.created = createClawAccountFromQr(s)
      }
      const accountId = await s.created
      qrSessions.delete(key)
      if (accountId === null) return { ok: false, status: 'error', error: '建号失败,请重试' }
      return { ok: true, status: 'confirmed', accountId }
    }
    if (status === 'expired' || status === 'canceled' || status === 'cancelled') {
      qrSessions.delete(key)
      return { ok: true, status: 'expired' }
    }
    if (status === 'scaned' || status === 'scanned') return { ok: true, status: 'scanned' }
    return { ok: true, status: 'waiting' }
  } catch (e) {
    return { ok: false, status: 'error', error: e instanceof Error ? e.message : String(e) }
  }
}

async function createClawAccountFromQr(s: QrSession): Promise<number | null> {
  try {
    const r = saveImAccount({
      channel: 'wechat_claw',
      name: s.name,
      enabled: true,
      config: {
        baseUrl: s.baseUrl,
        clawToken: sealSecret(s.token ?? ''),
        wxid: s.wxid,
        allowUsers: s.allowUsers
      }
    })
    if (!r.ok || r.id === undefined) return null
    clawLog.info(`扫码绑定 ClawBot 成功,已建号 #${r.id}(${s.name})`)
    // 与「保存账号」一致:建号后立即拉起长轮询
    const st = await startWechatClawAccount(r.id, s.name)
    if (!st.ok) clawLog.warn(`建号成功但启动失败 acct=${r.id}:${st.error ?? ''}`)
    return r.id
  } catch (e) {
    clawLog.error('扫码建号失败', e)
    return null
  }
}
