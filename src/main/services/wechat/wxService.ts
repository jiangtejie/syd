import * as keyStore from '../keyStoreService'
import { testWxConnection } from './wxDb'
import {
  listSessions,
  listMessages,
  listMessagesSince,
  enrichMessagesWithSenders,
  enrichSessionsWithContacts,
  annotateUnreadLastSender,
  getAvatar,
  queryContactDisplayNames,
  getRedEnvelopeStatuses as queryRedEnvelopeStatuses
} from './queries'
import { computeOpsStats } from './opsStats'
import { decorateVoiceTranscripts } from '../media/voiceTranscript'
import type { ChatMessage, OpsStats, WxConnectInfo, MessageCursor } from '../../../shared/types'

/**
 * 微信通道门面（T4）。
 * - 密钥一律从 keyStore 解密获取，渲染端不直接接触明文 key
 * - 提供连接状态 / 会话列表 / 消息读取
 */

export interface WxSession {
  /** 微信根路径（用户配置） */
  dbPath: string
  wxid: string
  /** 账号口令（KDF 之前）；只导入了密钥文件时为空字符串 */
  hexKey: string
  /** 取**某一个库**该用的密钥：密钥环优先，回退账号口令 */
  keyFor: (filePath: string) => string
}

/** 从 keyStore 组装读库上下文；账号口令与每库密钥环都为空时返回 null */
export function buildWxSession(wxid: string): WxSession | null {
  if (!keyStore.hasAnyKey(wxid)) return null
  const profile = keyStore.getKeyStatus(wxid)
  return {
    dbPath: profile.dbPath || '',
    wxid,
    hexKey: keyStore.getDecryptedKey(wxid) || '',
    keyFor: (filePath: string) => keyStore.resolveKeyForFile(wxid, filePath) || ''
  }
}

/** 连接校验：真实试开微信库，成功则把 key 标记为 valid */
export function connect(wxid: string): { ok: boolean; info?: WxConnectInfo; error?: string } {
  const session = buildWxSession(wxid)
  if (!session) return { ok: false, error: '未配置密钥，请先导入' }
  if (!session.dbPath) return { ok: false, error: '未配置微信数据根路径，请先导入时填写' }

  const result = testWxConnection(session.dbPath, session.wxid, session.hexKey, session.keyFor)
  if (result.ok) {
    keyStore.markKeyValid(wxid)
  } else {
    keyStore.markKeyInvalid(wxid, result.error)
  }
  return result
}

/** 会话列表（enrich 联系人信息） */
export function getSessions(wxid: string): ReturnType<typeof listSessions> {
  const session = buildWxSession(wxid)
  if (!session) return { ok: false as const, error: '未配置密钥，请先导入' }
  let result
  try {
    result = listSessions(session)
  } catch (err) {
    return { ok: false as const, error: `读取会话异常: ${(err as Error)?.message ?? err}` }
  }
  if (!result.ok || !result.sessions) return result
  const sessions = enrichSessionsWithContacts(result.sessions, session)
  // 有未读的会话标注"最后一条是否本人发出"，供待回复队列剔除已由本人收尾的会话
  annotateUnreadLastSender(sessions, session)
  return { ok: true as const, sessions }
}

/**
 * 消息分页读取（keyset）：before 为空取最新一页，否则取更早一页。
 * skipEnrich=true 用于「只关心时间/序号等元信息」或「多页读完再统一 enrich」的场景：
 * 每页 enrich 都要打开一次联系人库，翻 5 页就是 5 次开库（见 scripts/perf 记录）。
 */
export function getMessages(
  wxid: string,
  sessionId: string,
  limit = 50,
  before?: MessageCursor,
  skipEnrich = false
): ReturnType<typeof listMessages> {
  const session = buildWxSession(wxid)
  if (!session) return { ok: false as const, error: '未配置密钥，请先导入' }
  return listMessages(session, sessionId, limit, before, skipEnrich)
}

/**
 * 按会话批量补发送人昵称/头像（配合 getMessages(skipEnrich=true) 使用，一次开库补完整批）。
 *
 * 语音转写合流也在这里做：走批量路径的调用方（议题读取 readGroupMessages、数字员工值班）
 * 本来就跳过了 queries.listMessages 里那次装饰，不在这里补的话，它们读到的永远是「[语音]」
 * —— 云 ASR 转写白做，客户用语音提的诉求进不了闭环。界面路径不受影响（已装饰过一次，
 * 装饰函数对已有转写的消息直接跳过）。
 */
export function enrichMessages(
  wxid: string,
  sessionId: string,
  messages: ChatMessage[]
): ChatMessage[] {
  const session = buildWxSession(wxid)
  if (!session || messages.length === 0) return messages
  return decorateVoiceTranscripts(enrichMessagesWithSenders(messages, session, sessionId), wxid)
}

/** 增量消息（T5 轮询用） */
export function getMessagesSince(
  wxid: string,
  sessionId: string,
  sinceSortSeq: number,
  limit = 200
): ReturnType<typeof listMessagesSince> {
  const session = buildWxSession(wxid)
  if (!session) return { ok: false as const, error: '未配置密钥，请先导入' }
  return listMessagesSince(session, sessionId, sinceSortSeq, limit)
}

/** 会话内红包本地状态（general.db redEnvelopeTable） */
export function getRedEnvelopeStatuses(
  wxid: string,
  sessionId: string
): ReturnType<typeof queryRedEnvelopeStatuses> {
  const session = buildWxSession(wxid)
  if (!session) return { ok: false as const, error: '未配置密钥，请先导入' }
  return queryRedEnvelopeStatuses(session, sessionId)
}

/** 解析头像（contact URL 优先，head_image 本地 BLOB 兜底）。localOnly=远程 URL 已失败，强制取本地 */
export function getAvatarForUser(
  wxid: string,
  username: string,
  localOnly = false
): { ok: boolean; url?: string; error?: string } {
  const session = buildWxSession(wxid)
  if (!session) return { ok: false, error: '未配置密钥，请先导入' }
  const url = getAvatar(session, username, { localOnly })
  return url ? { ok: true, url } : { ok: false, error: '无头像' }
}

/** 批量解析联系人展示名（备注>昵称>alias）；无 key/库不可读时返回空表，调用方降级显示 username */
export function getContactNames(
  wxid: string,
  usernames: string[]
): { ok: boolean; names?: Record<string, string>; error?: string } {
  const session = buildWxSession(wxid)
  if (!session) return { ok: false as const, error: '未配置密钥，请先导入' }
  try {
    return { ok: true as const, names: queryContactDisplayNames(session, usernames ?? []) }
  } catch (err) {
    return { ok: false as const, error: `读取联系人异常: ${(err as Error)?.message ?? err}` }
  }
}

/** 运营统计（L2/L3）：窗口内活跃会话聚合，内部 60s 缓存 + dbChanged 失效 */
export async function getOpsStats(
  wxid: string,
  rangeDays = 7
): Promise<{ ok: boolean; stats?: OpsStats; error?: string }> {
  const session = buildWxSession(wxid)
  if (!session) return { ok: false as const, error: '未配置密钥，请先导入' }
  try {
    const stats = await computeOpsStats(session, rangeDays)
    return { ok: true as const, stats }
  } catch (err) {
    return { ok: false as const, error: `统计异常: ${(err as Error)?.message ?? err}` }
  }
}
