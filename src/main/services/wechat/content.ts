import { decompress } from 'fzstd'

/**
 * 消息内容解码（自研实现）。
 * 微信消息正文可能被 zstd 压缩存储（magic 0xFD2FB528），且不同消息类型正文为 XML/占位。
 */

const ZSTD_MAGIC = 0xfd2fb528

/** zstd magic 检测 + 解压为 utf8 字符串 */
function decodeBinaryContent(data: Buffer): string {
  if (data.length === 0) return ''
  try {
    if (data.length >= 4 && data.readUInt32LE(0) === ZSTD_MAGIC) {
      const out = decompress(data)
      return Buffer.from(out).toString('utf-8')
    }
    const decoded = data.toString('utf-8')
    const replacementCount = (decoded.match(/\uFFFD/g) || []).length
    if (replacementCount < decoded.length * 0.2) return decoded
    return data.toString('latin1')
  } catch {
    return ''
  }
}

/** 解码可能压缩的内容（Buffer / hex 字符串 / 普通字符串） */
export function decodeMessageContent(raw: any): string {
  if (!raw) return ''
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
    return decodeBinaryContent(Buffer.from(raw))
  }
  if (typeof raw === 'string') {
    if (raw.length === 0) return ''
    // 长 hex 字符串按二进制解码
    if (raw.length > 16 && raw.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(raw)) {
      const bytes = Buffer.from(raw, 'hex')
      if (bytes.length > 0) return decodeBinaryContent(bytes)
    }
    return raw
  }
  if (typeof raw === 'object' && Array.isArray((raw as any).data)) {
    return decodeBinaryContent(Buffer.from((raw as any).data))
  }
  return String(raw ?? '')
}

/** 文本消息去除发送者前缀（如 "wxid_xxx:\n"） */
export function stripSenderPrefix(content: string): string {
  return content.replace(/^[\s]*([a-zA-Z0-9_-]+):(?!\/\/)\s*/, '')
}

/** HTML 实体解码（消息正文常见） */
export function decodeHtmlEntities(content: string): string {
  return String(content || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

function extractXmlValue(xml: string, tagName: string): string {
  const regex = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'i')
  const match = regex.exec(xml)
  if (match) {
    return match[1].replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim()
  }
  return ''
}

function extractXmlAttribute(xml: string, tagName: string, attrName: string): string {
  const regex = new RegExp(`<${tagName}[^>]*\\s${attrName}\\s*=\\s*['"]([^'"]*)['"]`, 'i')
  const match = regex.exec(xml)
  return match ? match[1] : ''
}

export const MESSAGE_TYPE_LABELS: Record<number, string> = {
  1: '[文本]',
  3: '[图片]',
  34: '[语音]',
  42: '[名片]',
  43: '[视频]',
  47: '[表情]',
  48: '[位置]',
  49: '[链接/文件]',
  50: '[语音转文字]',
  10000: '[系统消息]'
}

/** 消息类型 -> 可展示摘要文本 */
export function parseMessageContent(content: string, localType: number): string {
  if (!content) return MESSAGE_TYPE_LABELS[localType] || '[消息]'
  const rawContent = content
  content = decodeHtmlEntities(content)

  switch (localType) {
    case 1:
      return stripSenderPrefix(content)
    case 3:
      return '[图片]'
    case 34:
      return '[语音]'
    case 42: {
      const nickname = content.match(/nickname="([^"]*)"/)?.[1]
      return nickname ? `[名片] ${nickname}` : '[名片]'
    }
    case 43:
      return '[视频]'
    case 47:
      return '[表情]'
    case 48: {
      const poiname = content.match(/poiname="([^"]*)"/)?.[1]
      return poiname ? `[位置] ${poiname}` : '[位置]'
    }
    case 49: {
      const type = extractXmlValue(rawContent, 'type')
      if (type === '6') {
        const fileName = extractXmlValue(rawContent, 'title')
        return fileName ? `[文件] ${fileName}` : '[文件]'
      }
      if (type === '57') {
        // 引用消息：title 是回复文字，被引用内容在 refermsg 里（由 parseQuoteMessage 解析）
        const title = decodeHtmlEntities(extractXmlValue(rawContent, 'title'))
        return title || '[引用消息]'
      }
      if (type === '19') {
        const title = extractXmlValue(rawContent, 'title')
        return title ? `[聊天记录] ${title}` : '[聊天记录]'
      }
      const title = extractXmlValue(rawContent, 'title')
      return title ? `[链接] ${title}` : '[链接/文件]'
    }
    case 10000:
      return cleanSystemMessage(content)
    default:
      return content
  }
}

/** 系统消息清洗：剥 XML 声明/标签 + 去尾部时间戳数字（参考 CipherTalk cleanSystemMessage） */
export function cleanSystemMessage(content: string): string {
  let cleaned = String(content || '')
  cleaned = cleaned.replace(/<\?xml[^?]*\?>/gi, '') // XML 声明
  cleaned = cleaned.replace(/<[^>]+>/g, '') // 所有标签
  cleaned = cleaned.replace(/\d+\s*$/, '') // 尾部时间戳数字（撤回消息后常带）
  cleaned = cleaned.replace(/\s+/g, ' ').trim()
  return cleaned || '[系统消息]'
}

/** 从 49 型 XML 提取图片 md5（供 T6 附件查看） */
export function parseImageMd5(content: string): string | undefined {
  const md5 =
    extractXmlValue(content, 'md5') ||
    extractXmlAttribute(content, 'img', 'md5') ||
    extractXmlAttribute(content, 'img', 'cdnthumbmd5') ||
    extractXmlAttribute(content, 'img', 'thumbfullmd5') ||
    undefined
  return md5 ? md5.toLowerCase() : undefined
}

/**
 * 从 packed_info_data（protobuf）提取真实图片文件名 md5。
 * 微信 4.x 图片 XML 里的 md5 是 CDN md5，本地 .dat 文件按另一个 md5 命名，
 * 该 md5 存在 packed_info_data 的字节流中（32 位 hex，前缀 `" `）。
 */
export function parsePackedInfoMd5(raw: any): string | undefined {
  if (!raw) return undefined
  let buf: Buffer
  if (Buffer.isBuffer(raw)) buf = raw
  else if (raw instanceof Uint8Array) buf = Buffer.from(raw)
  else if (typeof raw === 'string') buf = Buffer.from(raw, 'latin1')
  else return undefined
  const m = buf.toString('latin1').match(/[0-9a-f]{32}/i)
  return m ? m[0].toLowerCase() : undefined
}

/** 从 34 型提取语音时长（毫秒） */
export function parseVoiceDuration(content: string): number | undefined {
  const match = /voicelength\s*=\s*['"](\d+)['"]/i.exec(content)
  return match ? parseInt(match[1], 10) : undefined
}

/** 从 49 型提取文件名与大小 */
export function parseFileInfo(content: string): { fileName?: string; fileSize?: number } {
  if (extractXmlValue(content, 'type') !== '6') return {}
  const fileName = extractXmlValue(content, 'title')
  const totallen = extractXmlValue(content, 'totallen')
  const fileSize = totallen ? parseInt(totallen, 10) : undefined
  return { fileName: fileName || undefined, fileSize: Number.isFinite(fileSize) ? fileSize : undefined }
}

/** 清理引用内容中的 wxid 前缀与多余分隔符 */
function sanitizeQuotedContent(content: string): string {
  let result = content
  result = result.replace(/wxid_[A-Za-z0-9_-]{3,}/g, '')
  result = result.replace(/^[\s:：\-]+/, '')
  result = result.replace(/[:：]{2,}/g, ':')
  result = result.replace(/^[\s:：\-]+/, '')
  result = result.replace(/\s+/g, ' ').trim()
  return result
}

export interface QuoteInfo {
  content?: string
  sender?: string
  imageMd5?: string
}

/**
 * 解析引用消息（type 57）中被引用的那一条（<refermsg> 段）。
 * 返回被引用消息的摘要文本 / 发送人昵称 / 被引用图片 md5。
 */
export function parseQuoteMessage(content: string): QuoteInfo {
  try {
    const start = content.indexOf('<refermsg>')
    const end = content.indexOf('</refermsg>')
    if (start === -1 || end === -1) return {}
    const referMsgXml = content.substring(start, end + '</refermsg>'.length)

    let displayName = extractXmlValue(referMsgXml, 'displayname')
    if (displayName && /^wxid_/i.test(displayName)) displayName = ''

    let referContent = decodeHtmlEntities(extractXmlValue(referMsgXml, 'content'))
    const referType = extractXmlValue(referMsgXml, 'type')
    let imageMd5: string | undefined

    let displayContent = referContent
    switch (referType) {
      case '1':
        displayContent = sanitizeQuotedContent(referContent)
        break
      case '3':
        displayContent = '[图片]'
        imageMd5 =
          extractXmlValue(referContent, 'md5') || (referContent.match(/\bmd5="([a-f0-9]+)"/i)?.[1]) || undefined
        break
      case '34':
        displayContent = '[语音]'
        break
      case '43':
        displayContent = '[视频]'
        break
      case '47':
        displayContent = '[动画表情]'
        break
      case '49': {
        const appTitle = extractXmlValue(referContent, 'title')
        displayContent = appTitle ? `[链接] ${appTitle}` : '[链接]'
        break
      }
      case '42':
        displayContent = '[名片]'
        break
      case '48':
        displayContent = '[位置]'
        break
      default:
        if (!referContent || referContent.includes('wxid_')) displayContent = '[消息]'
        else displayContent = sanitizeQuotedContent(referContent)
    }

    return { content: displayContent, sender: displayName || undefined, imageMd5 }
  } catch {
    return {}
  }
}
