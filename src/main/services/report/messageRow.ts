import type { ChatMessage } from '../../../shared/types'
import type { PgMessageRow } from './pgWriter'
import { fmtStamp } from '../../../shared/monitorMetrics'
import { voiceColumnsOf } from '../media/voiceText'
import { contentFor, localTypeName } from './messageText'

/**
 * 微信消息 → PG `chat.messages` 行（装配层）。
 *
 * 这里只做「把各处纯口径拼起来」：类型名/占位正文在 messageText.ts，语音两列在 media/voiceText.ts
 * —— 那两块零依赖、被 scripts/report-voice-selftest.mjs 逐条钉住；本文件带 monitorMetrics 与 PG 类型
 * 导入，node 直接跑不起来，所以保持薄。
 */

/** 时间一律走共享口径（YYYY-MM-DD HH:mm:ss，精确到秒）；0 表示没有时间，保持空串 */
const fmtTime = (ms: number): string => (ms && ms > 0 ? fmtStamp(ms) : '')

export function toPgRow(sessionWxid: string, m: ChatMessage): PgMessageRow | null {
  const localId = Number(m.localId)
  if (!Number.isInteger(localId) || localId < 0) return null
  const typeName = localTypeName(m)
  const createSec = Math.floor(m.createTime / 1000)
  // 语音：时长与转写文本单独成列（下游要按「有文本的语音」筛/配对，靠 content 正则筛不靠谱）
  const voice = voiceColumnsOf({
    localType: m.localType,
    parsedContent: m.parsedContent,
    voiceDuration: m.voiceDuration
  })
  return {
    sessionWxid,
    localId,
    createTime: createSec,
    formattedTime: fmtTime(m.createTime),
    msgType: typeName,
    content: contentFor(m, typeName),
    isSend: m.isSend ? 1 : 0,
    senderUsername: m.senderUsername ?? null,
    senderDisplayName: m.senderNickname?.trim() ? m.senderNickname.trim() : null,
    groupNickname: null,
    replyToMessageId: null,
    mediaMd5: (m.imageMd5 ?? m.videoMd5 ?? m.fileMd5 ?? m.emojiMd5 ?? '').trim() || null,
    mediaPath: null,
    voiceText: voice.voiceText,
    voiceDurationMs: voice.voiceDurationMs
  }
}
