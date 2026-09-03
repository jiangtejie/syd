import * as keyStore from '../keyStoreService'
import { testWxConnection } from './wxDb'
import {
  listSessions,
  listMessages,
  listMessagesSince,
  enrichSessionsWithContacts,
  getAvatar,
  getRedEnvelopeStatuses as queryRedEnvelopeStatuses
} from './queries'
import { computeOpsStats } from './opsStats'
import type { OpsStats, WxConnectInfo, MessageCursor } from '../../../shared/types'

/**
 * 微信通道门面（T4）。
 * - 密钥一律从 keyStore 解密获取，渲染端不直接接触明文 key
 * - 提供连接状态 / 会话列表 / 消息读取
 */

export interface WxSession {
  /** 微信根路径（用户配置） */
  dbPath: string
  wxid: string
  hexKey: string
}

/** 从 keyStore 组装读库上下文；无 key 时返回 null */
export function buildWxSession(wxid: string): WxSession | null {
  const hexKey = keyStore.getDecryptedKey(wxid)
  if (!hexKey) return null
  const profile = keyStore.getKeyStatus(wxid)
  return {
    dbPath: profile.dbPath || '',
    wxid,
    hexKey
  }
}

/** 连接校验：真实试开微信库，成功则把 key 标记为 valid */
export function connect(wxid: string): { ok: boolean; info?: WxConnectInfo; error?: string } {
  const session = buildWxSession(wxid)
  if (!session) return { ok: false, error: '未配置密钥，请先导入' }
  if (!session.dbPath) return { ok: false, error: '未配置微信数据根路径，请先导入时填写' }

  const result = testWxConnection(session.dbPath, session.wxid, session.hexKey)
  if (result.ok) {
    keyStore.markKeyValid(wxid)
  } else {
    keyStore.markKeyInvalid(wxid, result.error)
  }
  return result
}

/** 会话列表（enrich 联系人信息） */
export function getSessions(wxid: string) {
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
  return { ok: true as const, sessions }
}

/** 消息分页读取（keyset）：before 为空取最新一页，否则取更早一页 */
export function getMessages(wxid: string, sessionId: string, limit = 50, before?: MessageCursor) {
  const session = buildWxSession(wxid)
  if (!session) return { ok: false as const, error: '未配置密钥，请先导入' }
  return listMessages(session, sessionId, limit, before)
}

/** 增量消息（T5 轮询用） */
export function getMessagesSince(
  wxid: string,
  sessionId: string,
  sinceSortSeq: number,
  limit = 200
) {
  const session = buildWxSession(wxid)
  if (!session) return { ok: false as const, error: '未配置密钥，请先导入' }
  return listMessagesSince(session, sessionId, sinceSortSeq, limit)
}

/** 会话内红包本地状态（general.db redEnvelopeTable） */
export function getRedEnvelopeStatuses(wxid: string, sessionId: string) {
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

/** 运营统计（L2/L3）：窗口内活跃会话聚合，内部 60s 缓存 + dbChanged 失效 */
export function getOpsStats(
  wxid: string,
  rangeDays = 7
): { ok: boolean; stats?: OpsStats; error?: string } {
  const session = buildWxSession(wxid)
  if (!session) return { ok: false as const, error: '未配置密钥，请先导入' }
  try {
    const stats = computeOpsStats(session, rangeDays)
    return { ok: true as const, stats }
  } catch (err) {
    return { ok: false as const, error: `统计异常: ${(err as Error)?.message ?? err}` }
  }
}
