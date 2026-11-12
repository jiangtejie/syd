import { feishuPlainText } from '../im/mdToPlain'
import { larkCall, type LarkCallResult } from './client'

/**
 * 飞书 IM 出站能力(机器人身份)。
 * - 发送文本单聊/群消息:复用 im/mdToPlain 的 Markdown → 纯文本降级 + 3000 字分片;
 * - 幂等:每次发送带 uuid(飞书侧按 uuid 去重,防止重试重复轰炸);
 * - 目标发现:列出机器人所在群;邮箱 → open_id(通讯录 batch_get_id)。
 * 注意:机器人只能给「在其可用范围内」的用户发单聊;范围外接口会返回错误。
 */

const CHUNK = 3000

/** 统一调用包装(实现见 client.ts) */
const call = larkCall

export type FeishuReceiveIdType = 'open_id' | 'chat_id'

export interface FeishuSendOutcome {
  ok: boolean
  /** 成功发出的消息 id(分片时为首片) */
  messageId?: string
  chunks: number
  error?: string
}

/**
 * 发送纯文本消息(机器人身份)。
 * @param idempotencyKey 幂等键(≤40 字;分片时自动追加序号,总长仍 ≤50)
 */
export async function sendImText(input: {
  receiveIdType: FeishuReceiveIdType
  receiveId: string
  text: string
  idempotencyKey?: string
}): Promise<FeishuSendOutcome> {
  const receiveId = (input.receiveId ?? '').trim()
  if (!receiveId) return { ok: false, chunks: 0, error: '缺少接收方 id(open_id / chat_id)' }
  const plain = feishuPlainText(input.text ?? '')
  if (!plain.trim()) return { ok: false, chunks: 0, error: '消息内容为空' }

  const chunks: string[] = []
  let rest = plain
  while (rest.length > 0) {
    chunks.push(rest.slice(0, CHUNK))
    rest = rest.slice(CHUNK)
  }

  let firstId: string | undefined
  for (let i = 0; i < chunks.length; i += 1) {
    const uuid = input.idempotencyKey ? `${input.idempotencyKey}-${i + 1}`.slice(0, 50) : undefined
    const r = await call<{ message_id?: string }>((api) =>
      api.request({
        method: 'POST',
        url: 'open-apis/im/v1/messages',
        params: { receive_id_type: input.receiveIdType },
        data: {
          receive_id: receiveId,
          msg_type: 'text',
          content: JSON.stringify({ text: chunks[i] }),
          ...(uuid ? { uuid } : {})
        }
      })
    )
    if (!r.ok) return { ok: false, chunks: i, error: r.error, messageId: firstId }
    if (i === 0) firstId = r.data.message_id
  }
  return { ok: true, chunks: chunks.length, messageId: firstId }
}

export interface FeishuChat {
  chatId: string
  name: string
  chatMode: string
}

/** 机器人所在的群列表(chat_id 选择器用) */
export async function listBotChats(): Promise<LarkCallResult<{ chats: FeishuChat[] }>> {
  const r = await call<{
    items?: Array<{ chat_id?: string; name?: string; chat_mode?: string }>
    has_more?: boolean
    page_token?: string
  }>((api) =>
    api.request({ method: 'GET', url: 'open-apis/im/v1/chats', params: { page_size: 100 } })
  )
  if (!r.ok) return r
  const chats = (r.data.items ?? [])
    .filter((x) => !!x.chat_id)
    .map((x) => ({
      chatId: x.chat_id as string,
      name: x.name || '(未命名群)',
      chatMode: x.chat_mode ?? ''
    }))
  return { ok: true, data: { chats } }
}

/** 邮箱 → open_id(逐个解析;查不到返回空) */
export async function resolveOpenIdByEmail(
  email: string
): Promise<LarkCallResult<{ openId: string }>> {
  const mail = (email ?? '').trim()
  if (!mail) return { ok: false, error: '请填写邮箱或 open_id' }
  // 直接粘贴 open_id:无需通讯录权限即可用
  if (/^ou_[A-Za-z0-9]+$/.test(mail)) return { ok: true, data: { openId: mail } }
  const r = await call<{
    user_list?: Array<{ user_id?: string; email?: string; status?: { is_resigned?: boolean } }>
  }>((api) =>
    api.request({
      method: 'POST',
      url: 'open-apis/contact/v3/users/batch_get_id',
      params: { user_id_type: 'open_id' },
      data: { emails: [mail] }
    })
  )
  if (!r.ok) return r
  const hit = (r.data.user_list ?? []).find((u) => !!u.user_id)
  if (!hit?.user_id) {
    return {
      ok: false,
      error:
        '未找到该邮箱对应的飞书用户(需为个人邮箱,且应用已开通 contact:user.id:readonly 并发布版本);' +
        '也可以直接把同事的 open_id(ou_…)填进来'
    }
  }
  return { ok: true, data: { openId: hit.user_id } }
}
