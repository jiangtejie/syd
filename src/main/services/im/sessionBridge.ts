import { createChat } from '../../db/repos/chatRepo'
import { mapChatSession, getMappedSession } from '../../db/repos/imRepo'

/** IM 外部聊天 → 本地 AI 会话(幂等;各聊天独立上下文,复用记忆/工具/ReAct 引擎) */
export async function createImSession(
  accountId: number,
  externalChatId: string,
  externalName: string
): Promise<number> {
  const existing = getMappedSession(accountId, externalChatId)
  if (existing) return existing.session_id
  const sessionId = createChat('', externalName.slice(0, 24) || 'IM 会话')
  mapChatSession(accountId, externalChatId, sessionId, externalName)
  return sessionId
}
