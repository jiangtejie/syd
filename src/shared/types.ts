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
  /** 会话最后一条消息是否本人发出（待回复判定用；消息库不可读时为 undefined 未知） */
  lastMsgIsSend?: boolean
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
  /** 转账消息（49/2000）付款/收款方 username（XML payer_username/receiver_username） */
  transferPayerUsername?: string
  transferReceiverUsername?: string
  /** 转账付款/收款显示名（主进程解析：群昵称/备注/昵称，己方为“我”） */
  transferPayerName?: string
  transferReceiverName?: string
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
/** 建议来源：ai_free=AI 自由生成 / kb_direct=知识库直答（枚举保留，内置示例模板已移除，待真实知识库接入） */
export type SuggestionSource = 'kb_direct' | 'ai_free'

/** 话术风格预设 */
export type AiStyle = 'formal' | 'warm' | 'brief'

/** 智能体（客服人设）：LLM 以何种身份/规则代为撰写回复 */
export interface AiAgent {
  id: string
  /** 显示名（如「热情糖水客服」） */
  name: string
  /** 一句话角色设定（追加进系统提示词） */
  description: string
  style: AiStyle
  /** 自定义人设/规则提示词；留空则按内置模板 + 名称/描述/风格自动组装 */
  prompt: string
  createdAt?: number
  updatedAt?: number
}

/** 保存智能体的入参（id 省略=新建） */
export interface AiAgentInput {
  id?: string
  name: string
  description: string
  style: AiStyle
  prompt: string
}

export interface ReplyCandidate {
  text: string
  source: SuggestionSource
  /** 简短理由/匹配说明（如命中的模板关键词），供 UI 展示 */
  reason?: string
}

export interface AiGenOptions {
  /** 兼容旧调用：直接指定话术风格（仅在未指定智能体时生效） */
  style?: AiStyle
  /** 使用的智能体 id；缺省/无效时回退到默认智能体 */
  agentId?: string
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

/** 发送审计聚合（看板用，基于 send_log） */
export interface SendOverview {
  /** 统计区间天数（近 N 天，含今天） */
  days: number
  /** 各结果计数（result 原值） */
  totals: Record<string, number>
  /** 成功消息中被闭环校验确认的比例 0~1；无成功记录为 null */
  verifiedRate: number | null
  /** 失败原因 Top（result=failed 且 error_reason 非空），按次数倒序 */
  failReasons: Array<{ reason: string; count: number }>
}

/** 消息级运营统计（看板用，基于微信消息库聚合） */
export interface OpsDayPoint {
  /** 本地日期标签（M/D） */
  day: string
  /** 客户发来的消息数 */
  inbound: number
  /** 我发出的消息数 */
  outbound: number
}

export interface OpsHourPoint {
  /** 0~23 */
  hour: number
  inbound: number
  outbound: number
}

export interface OpsTypeCount {
  label: string
  count: number
}

export interface OpsStats {
  /** 统计范围（自然日） */
  range: number
  /** 计算时间 */
  computedAt: number
  totals: {
    total: number
    inbound: number
    outbound: number
    /** 群聊消息数 */
    group: number
    /** 非群消息数（个人/公众号等） */
    privateChat: number
  }
  /** 每日收发趋势（含今天，长度=range） */
  trend: OpsDayPoint[]
  /** 24 小时收发分布（长度=24） */
  hours: OpsHourPoint[]
  /** 消息类型分布（含 49 型子类细分），按次数倒序 */
  typeDist: OpsTypeCount[]
  /** 响应时效：以一条回复结算其最近一条未回客户消息 */
  response: {
    /** 有效回复样本数 */
    samples: number
    /** 30 分钟内回复 */
    within30Min: number
    /** 2 小时内回复（含 30 分钟档） */
    within2h: number
    /** 窗口结束时仍未回（距今超 2 小时） */
    noResponse: number
    /** 回复间隔中位数（分钟），无样本为 null */
    medianMinutes: number | null
  }
}

// ── 群问题反馈（看板 · 智能提取 + 人工处理）──

/** 问题类型（LLM 输出与规则词典都收敛到该枚举） */
export type FeedbackIssueType =
  | '客诉'
  | '售后'
  | '物流'
  | '价格'
  | '咨询'
  | '建议'
  | '其他'

/** 处理状态：open 待处理 / done 已处理 / stalled 已搁置 / archived 已归档 */
export type FeedbackIssueStatus = 'open' | 'done' | 'stalled' | 'archived'

/** 提取方式：llm=OpenAI 兼容模型 / rule=本地关键词+未回复兜底 */
export type FeedbackIssueMethod = 'llm' | 'rule'

/** 问题关联的单条消息（摘要级，供"相关消息"展开与缩略展示） */
export interface FeedbackIssueMsg {
  time: number
  senderName: string
  isSend: boolean
  text: string
  imageMd5?: string
  localType?: number
}

export interface FeedbackIssue {
  id: number
  wxid: string
  groupUsername: string
  groupName: string
  type: FeedbackIssueType
  title: string
  summary?: string
  /** 首次出现时间（首条证据消息） */
  occurAt: number
  status: FeedbackIssueStatus
  method: FeedbackIssueMethod
  createdAt: number
  updatedAt: number
  /** 关联消息数（展开时才拉明细） */
  msgCount: number
}

export interface FeedbackIssueDetail extends FeedbackIssue {
  related: FeedbackIssueMsg[]
}

/** 分析任务运行态（看板按钮与提示用） */
export interface FeedbackAnalysisState {
  running: boolean
  wxid?: string
  method?: FeedbackIssueMethod
  error?: string
  lastAt?: number
  issueCount?: number
}

export interface FeedbackTypeCount {
  type: FeedbackIssueType
  count: number
}

