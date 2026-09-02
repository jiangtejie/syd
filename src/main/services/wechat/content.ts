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
        return '[引用消息]'
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
