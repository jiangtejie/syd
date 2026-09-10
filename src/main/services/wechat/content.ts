import { decompress } from 'fzstd'
import type { ChatRecordItem } from '../../../shared/types'

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
export function decodeMessageContent(raw: unknown): string {
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
  if (typeof raw === 'object' && raw !== null) {
    const data = (raw as { data?: unknown }).data
    if (Array.isArray(data)) return decodeBinaryContent(Buffer.from(data as number[]))
  }
  return String(raw ?? '')
}

/** 文本消息去除发送者前缀（如 "wxid_xxx:\n"） */
export function stripSenderPrefix(content: string): string {
  return content.replace(/^[\s]*([a-zA-Z0-9_-]+):(?!\/\/)\s*/, '')
}

/** HTML 实体解码（消息正文常见，含数字/十六进制实体） */
export function decodeHtmlEntities(content: string): string {
  const decodeCodePoint = (value: string, radix: 10 | 16, fallback: string): string => {
    const cp = parseInt(value, radix)
    if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return fallback
    try {
      return String.fromCodePoint(cp)
    } catch {
      return fallback
    }
  }
  return String(content || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (entity, hex) => decodeCodePoint(hex, 16, entity))
    .replace(/&#(\d+);/g, (entity, dec) => decodeCodePoint(dec, 10, entity))
}

/**
 * 正则编译缓存：这两个提取器有 59 个调用点，每条消息要跑十几次到几十次
 * (聊天记录消息每个 recorditem 18 次)，每次 new RegExp 是纯浪费。
 */
const xmlValueReCache = new Map<string, RegExp>()
const xmlAttrReCache = new Map<string, RegExp>()

function xmlValueRegex(tagName: string): RegExp {
  let re = xmlValueReCache.get(tagName)
  if (!re) {
    re = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'i')
    xmlValueReCache.set(tagName, re)
  }
  return re
}

function xmlAttrRegex(tagName: string, attrName: string): RegExp {
  const key = `${tagName}|${attrName}`
  let re = xmlAttrReCache.get(key)
  if (!re) {
    re = new RegExp(`<${tagName}[^>]*\\s${attrName}\\s*=\\s*['"]([^'"]*)['"]`, 'i')
    xmlAttrReCache.set(key, re)
  }
  return re
}

function extractXmlValue(xml: string, tagName: string): string {
  const match = xmlValueRegex(tagName).exec(xml)
  if (match) {
    return match[1]
      .replace(/<!\[CDATA\[/g, '')
      .replace(/\]\]>/g, '')
      .trim()
  }
  return ''
}

function extractXmlAttribute(xml: string, tagName: string, attrName: string): string {
  const match = xmlAttrRegex(tagName, attrName).exec(xml)
  return match ? match[1] : ''
}

export const MESSAGE_TYPE_LABELS: Record<number, string> = {
  1: '[文本]',
  3: '[图片]',
  34: '[语音]',
  42: '[名片]',
  43: '[视频]',
  47: '[动画表情]',
  48: '[位置]',
  49: '[链接/文件]',
  50: '[通话]',
  10000: '[系统消息]'
}

/** 通话消息（VoIP）：提取 <msg> 文本 */
function parseVoipMessage(content: string): string {
  const msg = extractXmlValue(content, 'msg')
  return msg || '通话'
}

/**
 * type 49（appmsg）子类型解析。
 * title/type 需在未解码的 rawContent 上提取，避免正文里粘贴的内嵌 XML 污染（其标签仍是转义态）。
 */
function parseType49(content: string, rawContent: string): string {
  const title = decodeHtmlEntities(extractXmlValue(rawContent, 'title'))
  const type = extractXmlValue(rawContent, 'type')

  // 群公告（type 87）
  if (type === '87') {
    const textAnnouncement = extractXmlValue(content, 'textannouncement')
    return textAnnouncement ? `[群公告] ${textAnnouncement}` : '[群公告]'
  }
  // 转账（type 2000）
  if (type === '2000') {
    const feedesc = extractXmlValue(content, 'feedesc')
    const payMemo = extractXmlValue(content, 'pay_memo')
    if (feedesc) return payMemo ? `[转账] ${feedesc} ${payMemo}` : `[转账] ${feedesc}`
    return '[转账]'
  }
  // 红包（type 2001）
  if (type === '2001') {
    const greeting =
      extractXmlValue(content, 'receivertitle') || extractXmlValue(content, 'sendertitle')
    return greeting ? `[红包] ${greeting}` : '[红包]'
  }
  // 微信礼物（type 115）
  if (type === '115') {
    const wish = extractXmlValue(content, 'wishmessage')
    const skutitle = extractXmlValue(content, 'skutitle')
    return skutitle
      ? `[微信礼物] ${wish || '送你一份心意'} - ${skutitle}`
      : `[微信礼物] ${wish || '送你一份心意'}`
  }
  // 音乐分享（type 3）
  if (type === '3') {
    const des = extractXmlValue(content, 'des')
    return title ? `[音乐] ${title}${des ? ` - ${des}` : ''}` : '[音乐]'
  }

  if (title) {
    switch (type) {
      case '5':
      case '49':
        return `[链接] ${title}`
      case '6':
        return `[文件] ${title}`
      case '19':
        return `[聊天记录] ${title}`
      case '33':
      case '36':
        return `[小程序] ${title}`
      case '57':
        // 引用消息，title 就是回复内容
        return title
      default:
        return title
    }
  }
  return '[消息]'
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
      return '[动画表情]'
    case 48: {
      const poiname = content.match(/poiname="([^"]*)"/)?.[1]
      const label = content.match(/label="([^"]*)"/)?.[1]
      return poiname ? `[位置] ${poiname}` : label ? `[位置] ${label}` : '[位置]'
    }
    case 49:
      return parseType49(content, rawContent)
    case 50:
      return parseVoipMessage(content)
    case 244813135921: {
      // 引用消息（微信 4.x 专属 localType）：title 是回复文字，被引用内容在 refermsg 里
      const title = decodeHtmlEntities(extractXmlValue(rawContent, 'title'))
      return title || '[引用消息]'
    }
    case 10000:
      return cleanSystemMessage(content)
    default: {
      // 未知 localType 时按 XML type 兜底识别 appmsg 子类型（红包/转账/群公告等）
      const xmlType = extractXmlValue(rawContent, 'type')
      if (
        xmlType === '87' ||
        xmlType === '2000' ||
        xmlType === '2001' ||
        xmlType === '115' ||
        xmlType === '3' ||
        xmlType === '5' ||
        xmlType === '6' ||
        xmlType === '19' ||
        xmlType === '33' ||
        xmlType === '36' ||
        xmlType === '49' ||
        xmlType === '57'
      ) {
        return parseType49(content, rawContent)
      }
      if (content.length > 200) return MESSAGE_TYPE_LABELS[localType] || '[消息]'
      return stripSenderPrefix(content) || MESSAGE_TYPE_LABELS[localType] || '[消息]'
    }
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

/** 解码 packed_info_data（protobuf 二进制），支持 Buffer / Uint8Array / hex / base64 / {data}（对齐 CipherTalk decodePackedInfo） */
function decodePackedInfo(raw: unknown): Buffer | null {
  if (!raw) return null
  if (Buffer.isBuffer(raw)) return raw
  if (raw instanceof Uint8Array) return Buffer.from(raw)
  if (Array.isArray(raw)) return Buffer.from(raw as number[])
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
      try {
        return Buffer.from(trimmed, 'hex')
      } catch {
        /* ignore */
      }
    }
    try {
      return Buffer.from(trimmed, 'base64')
    } catch {
      /* ignore */
    }
  }
  if (typeof raw === 'object' && raw !== null) {
    const data = (raw as { data?: unknown }).data
    if (Array.isArray(data)) return Buffer.from(data as number[])
  }
  return null
}

/**
 * 从 packed_info_data（protobuf）提取真实本地文件名 md5（图片 .dat / 视频 .mp4 命名）。
 * 微信 4.x 图片 XML 里的 md5 是 CDN md5，本地 .dat 文件按另一个 md5 命名，
 * 该 md5 存在 packed_info_data 的字节流中。
 * 对齐 CipherTalk parseImageDatNameFromRow：非可打印字节替换为空格后，
 * 优先匹配 `.dat` 文件名（8+ 位 hex），兜底匹配 16+ 位 hex。
 */
export function parsePackedInfoMd5(raw: unknown): string | undefined {
  const buffer = decodePackedInfo(raw)
  if (!buffer || buffer.length === 0) return undefined
  const printable: number[] = []
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i]
    printable.push(byte >= 0x20 && byte <= 0x7e ? byte : 0x20)
  }
  const text = Buffer.from(printable).toString('utf-8')
  const datMatch = /([0-9a-fA-F]{8,})(?:\.t)?\.dat/.exec(text)
  if (datMatch?.[1]) return datMatch[1].toLowerCase()
  const hexMatch = /([0-9a-fA-F]{16,})/.exec(text)
  return hexMatch?.[1]?.toLowerCase()
}

/** 从 34 型提取语音时长（毫秒） */
export function parseVoiceDuration(content: string): number | undefined {
  const match = /voicelength\s*=\s*['"](\d+)['"]/i.exec(content)
  return match ? parseInt(match[1], 10) : undefined
}

/** 从 49 型提取文件名与大小 */
export function parseFileInfo(content: string): {
  fileName?: string
  fileSize?: number
  fileExt?: string
  fileMd5?: string
} {
  if (extractXmlValue(content, 'type') !== '6') return {}
  const fileName = extractXmlValue(content, 'title')
  const totallen = extractXmlValue(content, 'totallen')
  const fileSize = totallen ? parseInt(totallen, 10) : undefined
  const fileExt = extractXmlValue(content, 'fileext')
  const fileMd5 = extractXmlValue(content, 'md5')?.toLowerCase()
  return {
    fileName: fileName || undefined,
    fileSize: Number.isFinite(fileSize) ? fileSize : undefined,
    fileExt: fileExt || undefined,
    fileMd5: fileMd5 || undefined
  }
}

/** 从 47 型表情 XML 提取 cdn 地址 / md5 / productId */
export function parseEmojiInfo(content: string): {
  cdnUrl?: string
  md5?: string
  productId?: string
} {
  try {
    let cdnUrl: string | undefined
    const cdnUrlMatch =
      /cdnurl\s*=\s*['"]([^'"]+)['"]/i.exec(content) ||
      /cdnurl\s*=\s*([^'"]+?)(?=\s|\/|>)/i.exec(content)
    if (cdnUrlMatch) {
      cdnUrl = cdnUrlMatch[1].replace(/&amp;/g, '&')
      if (cdnUrl.includes('%')) {
        try {
          cdnUrl = decodeURIComponent(cdnUrl)
        } catch {
          /* ignore */
        }
      }
    }
    if (!cdnUrl) {
      const thumbMatch =
        /thumburl\s*=\s*['"]([^'"]+)['"]/i.exec(content) ||
        /thumburl\s*=\s*([^'"]+?)(?=\s|\/|>)/i.exec(content)
      if (thumbMatch) {
        cdnUrl = thumbMatch[1].replace(/&amp;/g, '&')
        if (cdnUrl.includes('%')) {
          try {
            cdnUrl = decodeURIComponent(cdnUrl)
          } catch {
            /* ignore */
          }
        }
      }
    }
    const md5Match =
      /md5\s*=\s*['"]([a-fA-F0-9]+)['"]/i.exec(content) ||
      /md5\s*=\s*([a-fA-F0-9]+)/i.exec(content) ||
      /<md5>([^<]+)<\/md5>/i.exec(content)
    const md5 = md5Match ? md5Match[1] : undefined
    const idMatch =
      /productid\s*=\s*['"]([^'"]+)['"]/i.exec(content) ||
      /productid\s*=\s*([^'"]+?)(?=\s|\/|>)/i.exec(content)
    return { cdnUrl, md5, productId: idMatch ? idMatch[1] : undefined }
  } catch {
    return {}
  }
}

/** 从 3 型图片 XML 提取 md5 / 是否实况照片 */
export function parseImageInfo(content: string): { md5?: string; isLivePhoto?: boolean } {
  try {
    const isLivePhoto = /<live>/i.test(content)
    const contentNoLive = content.replace(/<live>[\s\S]*?<\/live>/gi, '')
    const md5 =
      extractXmlValue(contentNoLive, 'md5') ||
      extractXmlAttribute(contentNoLive, 'img', 'md5') ||
      extractXmlAttribute(contentNoLive, 'img', 'cdnthumbmd5') ||
      extractXmlAttribute(contentNoLive, 'img', 'thumbfullmd5') ||
      extractXmlAttribute(contentNoLive, 'img', 'fullmd5') ||
      undefined
    return { md5: md5?.toLowerCase(), isLivePhoto: isLivePhoto || undefined }
  } catch {
    return {}
  }
}

/** 从 43 型视频 XML 提取时长（秒） */
export function parseVideoDuration(content: string): number | undefined {
  if (!content) return undefined
  const match = /playlength\s*=\s*['"](\d+)['"]/i.exec(content)
  return match ? parseInt(match[1], 10) : undefined
}

/** 从 43 型视频 XML 提取 md5（32 位 hex） */
export function parseVideoMd5(content: string): string | undefined {
  if (!content) return undefined
  const md5 =
    extractXmlValue(content, 'md5') ||
    extractXmlAttribute(content, 'videomsg', 'md5') ||
    extractXmlValue(content, 'newmd5') ||
    extractXmlAttribute(content, 'videomsg', 'newmd5') ||
    extractXmlValue(content, 'rawmd5') ||
    extractXmlAttribute(content, 'videomsg', 'rawmd5') ||
    undefined
  const result = md5?.toLowerCase()
  return result && result !== 'null' && /^[a-f0-9]{32}$/.test(result) ? result : undefined
}

/** 解析合并转发聊天记录（type 19）中的逐条记录 */
export function parseChatHistory(content: string): ChatRecordItem[] | undefined {
  try {
    if (extractXmlValue(content, 'type') !== '19') return undefined
    const match = /<recorditem>[\s\S]*?<!\[CDATA\[([\s\S]*?)\]\]>[\s\S]*?<\/recorditem>/.exec(
      content
    )
    if (!match) return undefined
    const innerXml = match[1]

    const items: ChatRecordItem[] = []
    const itemRegex = /<dataitem\s+(.*?)>([\s\S]*?)<\/dataitem>/g
    let itemMatch: RegExpExecArray | null
    while ((itemMatch = itemRegex.exec(innerXml)) !== null) {
      const attrs = itemMatch[1]
      const body = itemMatch[2]
      const datatypeMatch = /datatype="(\d+)"/.exec(attrs)
      items.push({
        datatype: datatypeMatch ? parseInt(datatypeMatch[1], 10) : 0,
        sourcename: extractXmlValue(body, 'sourcename'),
        sourcetime: extractXmlValue(body, 'sourcetime'),
        sourceheadurl: extractXmlValue(body, 'sourceheadurl'),
        datadesc: decodeHtmlEntities(extractXmlValue(body, 'datadesc')),
        datatitle: decodeHtmlEntities(extractXmlValue(body, 'datatitle')),
        fileext: extractXmlValue(body, 'fileext'),
        datasize: parseInt(extractXmlValue(body, 'datasize') || '0') || undefined,
        messageuuid: extractXmlValue(body, 'messageuuid'),
        dataurl: decodeHtmlEntities(extractXmlValue(body, 'dataurl')),
        datathumburl: decodeHtmlEntities(
          extractXmlValue(body, 'datathumburl') || extractXmlValue(body, 'thumburl')
        ),
        datacdnurl: decodeHtmlEntities(
          extractXmlValue(body, 'datacdnurl') || extractXmlValue(body, 'cdnurl')
        ),
        md5: extractXmlValue(body, 'md5') || extractXmlValue(body, 'datamd5'),
        imgheight: parseInt(extractXmlValue(body, 'imgheight') || '0') || undefined,
        imgwidth: parseInt(extractXmlValue(body, 'imgwidth') || '0') || undefined,
        duration: parseInt(extractXmlValue(body, 'duration') || '0') || undefined
      })
    }
    return items.length > 0 ? items : undefined
  } catch {
    return undefined
  }
}

/** 清理引用内容中的 wxid 前缀与多余分隔符 */
function sanitizeQuotedContent(content: string): string {
  let result = content
  result = result.replace(/wxid_[A-Za-z0-9_-]{3,}/g, '')
  result = result.replace(/^[\s:：-]+/, '')
  result = result.replace(/[:：]{2,}/g, ':')
  result = result.replace(/^[\s:：-]+/, '')
  result = result.replace(/\s+/g, ' ').trim()
  return result
}

export interface QuoteInfo {
  content?: string
  sender?: string
  imageMd5?: string
  emojiMd5?: string
  emojiCdnUrl?: string
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

    const referContent = decodeHtmlEntities(extractXmlValue(referMsgXml, 'content'))
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
          extractXmlValue(referContent, 'md5') ||
          referContent.match(/\bmd5="([a-f0-9]+)"/i)?.[1] ||
          undefined
        break
      case '34':
        displayContent = '[语音]'
        break
      case '43':
        displayContent = '[视频]'
        break
      case '47': {
        displayContent = '[动画表情]'
        const emojiInfo = parseEmojiInfo(referContent)
        return {
          content: displayContent,
          sender: displayName || undefined,
          emojiMd5: emojiInfo.md5,
          emojiCdnUrl: emojiInfo.cdnUrl
        }
      }
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

/**
 * 会话摘要兜底（对齐 CipherTalk processSummary）：
 * 清洗控制字符后非空则原样返回，否则按最后消息类型生成默认摘要（如 [文本]/[图片]）。
 */
export function processSummary(summary: string, lastMsgType: number): string {
  /* eslint-disable no-control-regex -- 有意清洗控制字符(会话摘要) */
  const cleaned = String(summary || '')
    .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F-\x9F]/g, '')
    .trim()
  /* eslint-enable no-control-regex */
  if (cleaned) return cleaned
  return MESSAGE_TYPE_LABELS[lastMsgType] || '[消息]'
}

/** 从红包消息（type 49 / type=2001）XML 提取 sendId（nativeurl 的 ?sendid= 优先，paymsgid 兜底） */
export function parseRedEnvelopeSendId(content: string): string | undefined {
  if (!content) return undefined
  const nativeUrl = extractXmlValue(content, 'nativeurl')
  const fromUrl = /[?&]sendid=(\d+)/.exec(nativeUrl)?.[1]
  if (fromUrl) return fromUrl
  const payMsgId = extractXmlValue(content, 'paymsgid')
  return payMsgId || undefined
}

/** 转账消息（49 型 type=2000）付款/收款方 username（对齐 CipherTalk messageMapper 提取） */
export function parseTransferUsernames(content: string): {
  payerUsername?: string
  receiverUsername?: string
} {
  if (!content) return {}
  const payer = extractXmlValue(content, 'payer_username')
  const receiver = extractXmlValue(content, 'receiver_username')
  return {
    payerUsername: payer && !payer.includes(' ') ? payer : undefined,
    receiverUsername: receiver && !receiver.includes(' ') ? receiver : undefined
  }
}
