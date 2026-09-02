/**
 * 主进程 / preload / 渲染端共享类型（对应方案文档 §6 IPC 接口草案）
 */

// ── 密钥管理（§4.9 keyStore）──
export type KeySource = 'registry' | 'import' | 'manual'
export type KeyStatus = 'valid' | 'invalid' | 'pending'

export interface KeyProfile {
  id?: number
  wxid: string
  dbPath: string
  /** 加密后的 32 字节 key（hex），不落明文 */
  keyEncrypted: string
  source: KeySource
  status: KeyStatus
  importedAt: number
  updatedAt: number
}

export interface KeyStatusInfo {
  hasKey: boolean
  status: KeyStatus | null
  source: KeySource | null
  dbPath: string | null
  /** 最近一次 testKey 是否通过 */
  lastTestOk: boolean | null
}

/** 已保存密钥的账号摘要（不含密文），供设置页下拉选择当前账号 */
export interface KeyAccountInfo {
  wxid: string
  status: KeyStatus | null
  source: KeySource | null
  dbPath: string | null
  lastTestOk: boolean | null
}

// ── 会话 / 消息（T4 读库层产出）──
export interface SessionSummary {
  username: string
  displayName: string
  avatarUrl?: string
  remark?: string
  nickname?: string
  alias?: string
  type: number
  sortTimestamp: number
  lastTimestamp: number
  unreadCount: number
  summary: string
  lastMsgType: number
  isPinned: boolean
  isCollapsed: boolean
  isOfficialAccount: boolean
  isFoldGroup: boolean
  isWeCom: boolean
  /** 是否群聊（username 含 @chatroom） */
  isGroup: boolean
}

export type MessageLocalType = number

export interface ChatMessage {
  localId: number
  serverId: string
  serverSeq: number
  localType: MessageLocalType
  createTime: number
  sortSeq: number
  isSend: boolean
  /** 发送人 wxid（群消息为群成员 wxid；私聊对方消息为对方 wxid；自己发的为 null 或自己 wxid） */
  senderUsername: string | null
  /** 发送人昵称（群消息 enrich：优先群昵称/联系人备注）；私聊可空（用会话名） */
  senderNickname?: string
  /** 发送人头像（http URL 或 base64 data:image） */
  senderAvatarUrl?: string
  /** 是否群聊会话（冗余，渲染端便于判断） */
  isGroup?: boolean
  parsedContent: string
  rawContent: string
  imageMd5?: string
  isLivePhoto?: boolean
  voiceDuration?: number
  videoMd5?: string
  videoDuration?: number
  emojiCdnUrl?: string
  emojiMd5?: string
  productId?: string
  fileName?: string
  fileSize?: number
  fileExt?: string
  fileMd5?: string
  chatRecordList?: ChatRecordItem[]
  /** 引用消息：被引用内容的摘要文本 */
  quotedContent?: string
  /** 引用消息：被引用消息发送人昵称 */
  quotedSender?: string
  /** 引用消息：被引用图片的 md5 */
  quotedImageMd5?: string
  /** 引用消息：被引用表情的 md5 */
  quotedEmojiMd5?: string
  /** 引用消息：被引用表情的 cdn 地址 */
  quotedEmojiCdnUrl?: string
  /** 红包 sendId（type 49/2001），用于匹配本地领取状态（general.db redEnvelopeTable） */
  redEnvelopeSendId?: string
}

/** 合并转发聊天记录单条（type 19） */
export interface ChatRecordItem {
  datatype: number
  datadesc?: string
  datatitle?: string
  sourcename?: string
  sourcetime?: string
  sourceheadurl?: string
  fileext?: string
  datasize?: number
  messageuuid?: string
  dataurl?: string
  datathumburl?: string
  datacdnurl?: string
  md5?: string
  imgheight?: number
  imgwidth?: number
  duration?: number
}

/** 红包本地状态（general.db redEnvelopeTable），无金额与领取人列表 */
export interface RedEnvelopeStatus {
  sendId: string
  senderUsername: string
  /** 微信内部状态码（语义未完全确认，原样透传） */
  hbStatus: number
  hbType: number
  /** 2 = 我已领取；0 = 未领取 */
  receiveStatus: number
}

/** 微信库连接状态（T4 门面） */
export interface WxConnectInfo {
  connected: boolean
  dbStoragePath: string | null
  sessionDbPath: string | null
  msgDbCount: number
  error?: string
}

/** 分页结果 */
export interface PageResult<T> {
  items: T[]
  hasMore: boolean
}

/** 消息分页游标（keyset）：以库原始字段定位"更早的消息"。createTime 为库原始值（未转 ms） */
export interface MessageCursor {
  sortSeq: number
  createTime: number
  localId: number
}

/** 库文件变化信息（T5 监控桥推送） */
export interface DbChangeInfo {
  changedFiles: string[]
  sessionChanged: boolean
}

export interface DbChangedPayload {
  wxid: string
  info: DbChangeInfo
}

// ── AI 建议生成（T7，方案 §4.4）──
/** 建议来源：kb_direct=知识库直答（固定底稿）/ ai_free=AI 自由生成 */
export type SuggestionSource = 'kb_direct' | 'ai_free'

/** 话术风格预设 */
export type AiStyle = 'formal' | 'warm' | 'brief'

export interface ReplyCandidate {
  text: string
  source: SuggestionSource
  /** 简短理由/匹配说明（如命中的模板关键词），供 UI 展示 */
  reason?: string
}

export interface AiGenOptions {
  style?: AiStyle
}

export interface AiSuggestResult {
  candidates: ReplyCandidate[]
  /** 是否走了 LLM 生成（false=仅模板/兜底） */
  llm: boolean
  error?: string
}

// ── 发送执行（T8，方案 §4.5）──
export type SendResultStatus = 'sent' | 'rejected' | 'failed' | 'halted'

export interface SendResult {
  ok: boolean
  status: SendResultStatus
  error?: string
  /** 闭环校验结果（true=已确认发出/发对） */
  verified: boolean
  at: number
}

export interface SendStatusInfo {
  /** 是否熔断中 */
  halted: boolean
  /** 队列等待条数 */
  queued: number
  /** 今日已发送条数 */
  todayCount: number
  /** 每日上限 */
  dailyLimit: number
}
