/**
 * 落库正文与类型名的纯口径（**零依赖**，可被 scripts/report-voice-selftest.mjs 直接 import）。
 *
 * 单独成文件的原因：`toPgRow` 要用共享时间口径（monitorMetrics）与 PG 行类型，
 * 带上了本地 import 就没法被 node 的 ESM 解析器直接跑；把「不依赖任何东西」的这两条规则挪出来，
 * 自检就能钉住 `[语音]` / `[图片]` 这些占位与 49 型细分。
 */

/** 消息类型号 → 中文类型(chat-sync 命名对齐;49 型按解析字段细分) */
export function localTypeName(m: {
  localType: number
  chatRecordList?: unknown[]
  transferPayerUsername?: string
  transferReceiverUsername?: string
  redEnvelopeSendId?: string
  fileName?: string
  productId?: string
  quotedContent?: string
  quotedImageMd5?: string
  quotedEmojiMd5?: string
}): string {
  const t = m.localType
  if (t === 1) return '文本消息'
  if (t === 3) return '图片消息'
  if (t === 34 || t === 40) return '语音消息'
  if (t === 43) return '视频消息'
  if (t === 47) return '表情消息'
  if (t === 42) return '名片消息'
  if (t === 48) return '位置消息'
  if (t === 10000 || t === 10002) return '系统消息'
  if (t === 49) {
    if (m.chatRecordList && m.chatRecordList.length > 0) return '聊天记录'
    if (m.transferPayerUsername || m.transferReceiverUsername) return '转账消息'
    if (m.redEnvelopeSendId) return '红包消息'
    if (m.fileName) return '文件消息'
    if (m.productId) return '小程序消息'
    if (m.quotedContent || m.quotedImageMd5 || m.quotedEmojiMd5) return '引用消息'
    return '其他消息'
  }
  return '其他消息'
}

/** 落库正文：解析结果优先；解析为空时退回类型占位（语音就是 `[语音]`） */
export function contentFor(
  m: { parsedContent?: string; fileName?: string; productId?: string },
  typeName: string
): string {
  const p = (m.parsedContent ?? '').trim()
  if (p) return p
  const map: Record<string, string> = {
    文本消息: '[文本]',
    图片消息: '[图片]',
    语音消息: '[语音]',
    视频消息: '[视频]',
    表情消息: '[表情]',
    名片消息: '[名片]',
    位置消息: '[位置]',
    系统消息: '[系统消息]',
    文件消息: `[文件]${m.fileName ? ` ${m.fileName}` : ''}`,
    聊天记录: '[聊天记录]',
    转账消息: '[转账]',
    红包消息: '[红包]',
    小程序消息: `[小程序]${m.productId ? ` ${m.productId}` : ''}`,
    引用消息: '[引用消息]'
  }
  return map[typeName] ?? '[消息]'
}
