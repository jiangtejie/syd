import type { ChatMessage } from '../../../shared/types'
import { parseVoiceParsedContent } from '../media/voiceText'

/**
 * 消息 → 文本 / 「机器读不读得懂」的纯判定。
 *
 * 为什么单独成模块：语音转写有没有真的进闭环，只能靠离线自检钉住，而 shared.ts 会拉进
 * wxService → electron，脚本 import 不了。这里只依赖 voiceText（本身零依赖），
 * scripts/voice-pipeline-selftest.mjs 能直接跑。
 */

/** 单条消息转人类可读文本（供 LLM 上下文与规则匹配） */
export function msgToText(m: ChatMessage): string {
  switch (m.localType) {
    case 1:
      return m.parsedContent || '[文本]'
    case 3:
      return '[图片]'
    // 语音必须读 parsedContent：读取层没转写时它是空的，有转写时已被
    // decorateVoiceTranscripts 合流成「[语音] 8″ 转写文本」。以前这里硬编码 '[语音]'，
    // 等于把已付费的云 ASR 结果在分析链路门口丢掉。
    case 34:
      return m.parsedContent || '[语音]'
    case 43:
      return '[视频]'
    case 47:
      return '[表情]'
    default:
      return m.parsedContent || '[消息]'
  }
}

/** 转写是否已合流进 parsedContent（只有「[语音] 8″」这种占位、没有正文的算没有） */
export function hasTranscriptText(parsedContent: string | undefined): boolean {
  return parseVoiceParsedContent(parsedContent ?? '').text.length > 0
}

/** LLM 上下文行消息过滤（真文本 + 带摘要的 appmsg + 图片） */
export function isTextLike(m: ChatMessage): boolean {
  return m.localType === 1 || m.localType === 49
}

/** 规则模式只吃真文本（type 1）；49 型摘要（[链接]/[文件]/[聊天记录]/[转账]）会引入假关键词，不参与匹配 */
export function isRuleText(m: ChatMessage): boolean {
  return m.localType === 1
}

/**
 * 「这条消息机器读得懂吗」——数字员工据此决定要不要因为「看不懂」转人工。
 *
 * 语音在有转写时算读得懂：一期把语音一律当非文本转人工，结果是客户用语音提的诉求
 * （「这批鸡爪明天到不了我就换供应商」）既进不了议题分析、也进不了值班判定。
 * 仍读不懂的（图片/视频/表情/没转写的语音）继续走转人工。
 */
export function isMachineReadable(m: ChatMessage): boolean {
  if (isRuleText(m)) return true
  return m.localType === 34 && hasTranscriptText(m.parsedContent)
}
