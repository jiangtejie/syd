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
  /** 发送人是否为已全局标记的团队客服成员（我方同事；用于展示与分析判定） */
  senderIsTeam?: boolean
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
export type FeedbackIssueType = '客诉' | '售后' | '物流' | '价格' | '咨询' | '建议' | '其他'

/** 处理状态：open 待处理 / done 已处理 / stalled 已搁置 / archived 已归档 */
export type FeedbackIssueStatus = 'open' | 'done' | 'stalled' | 'archived'

/** 严重度（分析提取：LLM 判定 + 规则情绪词升级；默认 一般） */
export type FeedbackIssueSeverity = '紧急' | '高' | '一般'

/** 提取方式：llm=OpenAI 兼容模型 / rule=本地关键词+未回复兜底 */
export type FeedbackIssueMethod = 'llm' | 'rule'

/** 问题关联的单条消息（摘要级，供"相关消息"展开与缩略展示） */
export interface FeedbackIssueMsg {
  time: number
  senderName: string
  /** 发送人 username（客户身份归并/复发识别用；改昵称也能认出同一个人） */
  senderUsername?: string
  isSend: boolean
  /** 是否团队客服成员（我方同事） */
  senderIsTeam?: boolean
  text: string
  imageMd5?: string
  /** 视频证据 md5（微信 4.x 视频落地即明文 mp4） */
  videoMd5?: string
  /** 文件证据 md5（当前仅登记，不上传附件） */
  fileMd5?: string
  /** 文件证据原始文件名 */
  fileName?: string
  localType?: number
}

export interface FeedbackIssue {
  id: number
  /** 稳定 key（提取锚点派生）：重复分析复用同一行，也用于人工字段在重算中的回填 */
  key: string
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
  /** 跟进人：团队客服成员 username（cs:team 维护，按账号作用域）；空 = 未指派 */
  assignee?: string
  /** 是否由引擎自动闭环（客户静默收尾 / 检测到客服已回复后自动 done） */
  autoDone?: boolean
  /** 闭环时间（置 done/stalled 时写入，重开清空）：趋势与「今日解决」的口径来源 */
  resolvedAt?: number
  /** 跟进中：客服/团队已回复但尚未闭环（规则按回复判定、LLM 按 status=跟进中 输出） */
  followUp?: boolean
  /** 客服最后一次回复时间（跟进超时的计时起点；仅规则判定写入） */
  followUpAt?: number
  /**
   * 最后回复该议题的团队客服 username（规则判定写入；NULL = 我本人回复或无人回复）。
   * 未指派跟进人时，面板据此给出「默认跟进人」建议。
   */
  lastReplyBy?: string
  /** 跟进超时：followUp 且客服最后回复距今超 12 小时仍未闭环（仅 open 行动态计算） */
  followUpOverdue?: boolean
  /** 处理备注：同事在飞书多维表格里写的结论（Base → 本地，只读展示，不参与跟进判定） */
  note?: string
  /** 严重度（提取写入；规则情绪词可升级） */
  severity?: FeedbackIssueSeverity
  /** 疑似待人工确认（规则弱命中；不计入正式待办口径与徽标） */
  needConfirm?: boolean
  /** 复发次数：同群同客户同类型、上次已闭环后又出现（0 = 首次） */
  reopenCount?: number
  /** 复发来源：上一次闭环议题 id（详情可回溯上次处理） */
  reopenedFrom?: number
  /**
   * 归档前状态：
   * - open = 人工判定「不是问题」；
   * - done/stalled = 历史已闭环归档（仍计入累计闭环率）；
   * - duplicate = 存量去重合并掉的重复行（不算闭环、也不作为 LLM 反例）。
   */
  archivedFrom?: FeedbackIssueStatus | 'duplicate'
  /** 涉及的客户（LLM 输出 customers / 规则发送人归一；已持久化供复发与统计） */
  customers?: string[]
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
  /** 上次全量重析实际覆盖的群数 */
  groups?: number
  /** 窗口内活跃群总数（groups < groupsTotal 说明被 MAX_GROUPS 截断） */
  groupsTotal?: number
  /** 活跃群超过单次扫描上限（UI 明示未覆盖全部群） */
  groupsCapped?: boolean
  /** 上次全量重析被用户取消（已扫过的群结果保留） */
  cancelled?: boolean
}

export interface FeedbackTypeCount {
  type: FeedbackIssueType
  count: number
}

/** 团队客服成员（全局标识，按微信账号作用域） */
export interface TeamMemberInfo {
  username: string
  /** 自定义备注（如「店长-小张」），展示用 */
  label?: string
}

// ── AI 对话助手（页面 AI 菜单）──

export interface ChatSessionItem {
  id: number
  wxid: string
  title: string
  agentId?: string
  createdAt: number
  updatedAt: number
}

export type ChatMsgRole = 'user' | 'assistant' | 'system'
export type ChatMsgKind = 'text' | 'tool_call' | 'tool_result' | 'compact' | 'error'

export interface ChatMsgItem {
  id: number
  sessionId: number
  role: ChatMsgRole
  kind: ChatMsgKind
  content: string
  meta?: string
  createdAt: number
}

/** 多轮消息(发送给 LLM 的形态) */
export interface ChatTurn {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** 会话工具执行事件(渲染端工具卡片) */
export interface AiChatEvent {
  type: 'delta' | 'tool' | 'done' | 'error' | 'status'
  chatId: number
  wxid?: string
  token?: string
  tool?: string
  toolStatus?: 'start' | 'pending' | 'done' | 'fail'
  args?: string
  /** ReAct 显式思考(工具调用前模型给出的判断,JSON 协议轮) */
  thought?: string
  resultClip?: string
  messageId?: number
  text?: string
}

// ── IM 渠道(飞书机器人 / 微信 ClawBot) ──

/** 渠道类型:feishu=飞书机器人;wechat_claw=微信官方 ClawBot(iLink) */
export type ImChannelKind = 'feishu' | 'wechat_claw'

/**
 * 接收策略(飞书渠道):
 *  - off       仅推送:不建立长连接、不接收任何消息;
 *  - allowlist 只收白名单内同事的私聊,拒收所有群消息(默认推荐);
 *  - all        私聊全收 + 群聊 @ 机器人(白名单非空时仍会过滤)。
 */
export type ImChannelReceiveMode = 'off' | 'allowlist' | 'all'

export interface ImChannelAccount {
  id: number
  channel: ImChannelKind
  name: string
  enabled: boolean
  createdAt: number
  updatedAt: number
  /** 绑定的微信业务账号(wxid;设置后该渠道会话具备 L1 业务查询能力) */
  wxid?: string
  /** 业务查询白名单(渠道用户标识,逗号分隔;绑定账号后非空即启用) */
  allowUsers?: string
  /** 接收策略(默认按 all 兼容历史账号) */
  receiveMode?: ImChannelReceiveMode
  /** 指令权限名单(open_id → viewer/operator/admin);白名单内未列出者默认 operator */
  permissions?: Record<string, string>
  /** 实时连接状态(查询时由主进程填充) */
  status?: 'connected' | 'connecting' | 'stopped' | 'error'
  statusText?: string
}

export interface ImChannelAccountInput {
  id?: number
  channel: ImChannelKind
  name: string
  appId: string
  appSecret: string
  /** 微信 ClawBot 网关(默认 https://ilinkai.weixin.qq.com) */
  baseUrl?: string
  /** 微信 ClawBot bot_token(加密存储,不回显) */
  clawToken?: string
  enabled?: boolean
  /** 绑定的微信业务账号(wxid;可空=通用对话) */
  wxid?: string
  /** 业务查询白名单(逗号分隔的用户标识;空=不限制) */
  allowUsers?: string
  /** 接收策略:off 仅推送 / allowlist 只收白名单私聊(拒群)/ all 全收 */
  receiveMode?: ImChannelReceiveMode
  /** 指令权限名单(open_id → viewer/operator/admin);白名单内未列出者默认 operator */
  permissions?: Record<string, string>
}

// ── IM 审计/任务 + 飞书通知/通讯录(主进程产出 → 渲染端消费;避免 preload 手抄一份) ──

/** im_audit 行:入站审计 + 任务生命周期 */
export interface ImAuditEntry {
  id: number
  accountId: number
  chatId: string
  sessionId: number | null
  senderOpenId: string
  chatType: string
  kind: string
  text: string
  status: string
  progress: string
  result: string
  replyLen: number
  tools: string
  elapsedMs: number
  error: string
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

/** 飞书通知接收目标 */
export interface FeishuNotifyTargetInfo {
  kind: 'chat' | 'user'
  id: string
  name: string
}

/** 飞书通知配置(设置页) */
export interface FeishuNotifyConfigView {
  enabled: boolean
  targets: FeishuNotifyTargetInfo[]
  events: string[]
  dailyLimit: number
}

/** 飞书应用凭证状态(设置页展示) */
export interface FeishuCredentialView {
  configured: boolean
  source: string
  appIdMasked: string
  accountName?: string
  defaultUrl?: string
}

/** 通讯录成员 */
export interface FeishuContactUser {
  openId: string
  name: string
  email?: string
}

/** 通讯录可见范围 */
export interface FeishuContactScopeView {
  departments: Array<{ id: string; name: string }>
  users: FeishuContactUser[]
  empty: boolean
  authUrl: string
  appIdMasked: string
}

/** 机器人所在群 */
export interface FeishuChatView {
  chatId: string
  name: string
  chatMode: string
}

// ── 工作台工具名展示(渲染端工具卡/证据来源/审批条 + 主进程导出 Markdown 共用) ──
/** 工具英文标识 → 中文短名(无映射回退英文原标识) */
export const TOOL_CN_NAMES: Record<string, string> = {
  query_issues: '查询问题',
  query_group_issues: '查询群问题',
  search_issue_history: '搜索问题历史',
  monitor_summary: '监控概览',
  customer_lookup: '客户资料',
  recent_messages: '最近消息',
  list_team_members: '团队名单',
  send_message: '发送消息',
  software_status: '软件状态',
  data_scope: '数据范围',
  bi_stats: '数据统计',
  export_preview: '导出预览',
  im_channels_status: 'IM 通道状态',
  workspace_list: '浏览工作区',
  workspace_read: '读取文件',
  workspace_search: '搜索文件',
  workspace_file_info: '文件信息',
  workspace_write: '写入文件',
  workspace_mkdir: '新建目录',
  workspace_delete: '删除文件',
  csv_read: 'CSV 预览',
  csv_append: 'CSV 追加',
  xlsx_preview: 'Excel 预览',
  xlsx_write: '生成 Excel',
  site_scaffold: '建站脚手架'
}

export function toolCnName(name: string): string {
  return TOOL_CN_NAMES[name] ?? name
}

/* ══════════ 数据上报·定时任务(ReportJobs)══════════ */

/** 目标库:PostgreSQL(chat-sync 兼容 schema) */
export interface ReportPgTarget {
  host: string
  port: number
  database: string
  user: string
  schema: string
  /** 明文口令,仅保存/编辑时提交;列表与回显一律不返回(hasPassword 代替) */
  password?: string
}

/** 上报数据范围 */
export interface ReportChatScope {
  /** 会话范围:all=全部 groups=仅群聊 single=仅单聊 list=白名单 */
  sessionMode: 'all' | 'groups' | 'single' | 'list'
  /** sessionMode=list 时的会话 username 白名单(每行一个/逗号分隔文本) */
  sessionList?: string
  /** 首轮全量回溯天数(0=全部历史) */
  daysBack: number
  /** 单轮消息上限(0=不限,防失控) */
  maxPerRun: number
  /** 每轮处理会话数上限(0=不限;首轮全量可切小,未处理会话下轮续) */
  sessionsPerRun?: number
  /**
   * 每轮最多转写几条语音(0=关闭)。语音在微信里是 SILK、消息里只有 [语音] 占位,
   * 不主动转写的话下游只能看到占位;预算=尝试次数,见 services/report/voicePlan。
   */
  asrPerRun?: number
}

export type ReportScheduleKind = 'interval' | 'daily' | 'manual'

/** 任务配置(存储/列表往返;password 永不出主进程) */
export interface ReportJobInput {
  id?: number
  name: string
  type: 'chat_sync'
  enabled: boolean
  scheduleKind: ReportScheduleKind
  /** scheduleKind=interval:秒 */
  intervalSec?: number
  /** scheduleKind=daily:HH:mm */
  dailyTime?: string
  /** 数据源账号(wxid) */
  accountWxid: string
  scope: ReportChatScope
  target: ReportPgTarget
}

/** 任务列表行(含最近一次运行摘要与口令占位标记) */
export interface ReportJobInfo {
  id: number
  name: string
  type: string
  enabled: boolean
  scheduleKind: ReportScheduleKind
  intervalSec: number
  dailyTime: string
  accountWxid: string
  scope: ReportChatScope
  target: Omit<ReportPgTarget, 'password'> & { hasPassword: boolean }
  lastStatus?: string
  lastSummary?: string
  lastAt?: number
  createdAt: number
  updatedAt: number
}

/** 运行历史行 */
export interface ReportRunInfo {
  id: number
  jobId: number
  trigger: string
  status: string
  added: number
  sessionsOk: number
  sessionsSkip: number
  errors?: string
  startedAt: number
  endedAt?: number
  durationMs?: number
}

export const REPORT_TYPE_LABEL: Record<string, string> = { chat_sync: '聊天记录上报(PG)' }
export const REPORT_SCHEDULE_LABEL: Record<string, string> = {
  interval: '按间隔',
  daily: '每日定点',
  manual: '仅手动'
}
export const REPORT_SESSION_MODE_LABEL: Record<string, string> = {
  all: '全部会话',
  groups: '仅群聊',
  single: '仅单聊',
  list: '白名单会话'
}

// ── 数字员工（值班自动应答）──────────────────────────────

/** 话术命中模式：kw=关键词包含；re=正则 */
export interface DutyScriptPattern {
  type: 'kw' | 're'
  value: string
}

/** 风险等级：A=可自动发；B=需人工确认；C=永不自动（价格/退款/投诉/合同类） */
export type DutyRiskLevel = 'A' | 'B' | 'C'

/** 话术（数字员工的口径） */
export interface DutyScript {
  id: number
  accountWxid: string
  intent: string
  title: string
  patterns: DutyScriptPattern[]
  replyText: string
  riskLevel: DutyRiskLevel
  priority: number
  enabled: boolean
  source: string
  hitCount: number
  lastHitAt?: number
}

export interface DutyScriptInput {
  id?: number
  intent: string
  title?: string
  patterns: DutyScriptPattern[]
  replyText: string
  riskLevel?: DutyRiskLevel
  priority?: number
  enabled?: boolean
}

/** 群级自动回复设置：未配置的群继承全局默认 */
export interface DutyGroupSwitch {
  enabled: boolean
  /** shadow=只记录不发送（校准期）；live=可发送（仍过风险闸门） */
  mode: 'shadow' | 'live'
  note: string
}

/** 一条决策记录（影子模式与实发共用） */
export interface DutyReply {
  id: number
  accountWxid: string
  groupUsername: string
  groupName: string
  triggerSeq?: number
  triggerTime?: number
  triggerText: string
  decision: 'script' | 'llm' | 'handoff' | 'skip'
  scriptId?: number
  intent: string
  /** 意图来源：script（命中话术）/rule（规则层）/llm（模型复核）/none（未归类） */
  intentSource?: string
  /** 意图置信度 0~1 */
  intentConfidence?: number
  /** 命中词（顿号分隔） */
  intentEvidence?: string
  replyText: string
  riskLevel: string
  status: 'shadow' | 'queued' | 'approved' | 'sent' | 'failed' | 'rejected'
  reason: string
  feedback: string
  sentAt?: number
  verifyOk?: number
  error?: string
  createdAt: number
}

export interface DutyStatus {
  enabled: boolean
  defaultEnabled: boolean
  defaultMode: 'shadow' | 'live'
  /** 已单独设置过的群数 */
  overrides: number
  scripts: number
  shadowLlm: boolean
  /** 意图为空、可一键补全的历史记录数 */
  missingIntent: number
}

export interface DutyStats {
  total: number
  script: number
  llm: number
  handoff: number
  noMatchRate: number
}

export interface DutyPreviewRow {
  group: string
  groupName: string
  time: number
  sender: string
  text: string
  action: 'reply' | 'handoff' | 'llm'
  intent: string
  reply: string
  reason: string
}

export interface DutyPreview {
  days: number
  groups: Array<{
    group: string
    name: string
    msgs: number
    decisions: number
    handoff: number
    nonText: number
  }>
  samples: DutyPreviewRow[]
  intents: Array<{ intent: string; n: number }>
  totals: { groups: number; msgs: number; decisions: number; handoff: number; nonText: number }
}

/** 议题 → 飞书多维表格同步状态（设置页展示用） */
export interface LarkBaseStatus {
  configured: boolean
  link?: string
  appToken?: string
  issuesTableId?: string
  repliesTableId?: string
  enabled: boolean
  rawEvidence: boolean
  lastAt: number
  mappedIssues: number
  mappedReplies: number
  hint: string
  lastPull: LarkPullResult | null
  lastResult: LarkSyncOut | null
  /** 数字员工影子记录最近一次推送结果 */
  lastReplies: LarkSyncOut | null
  /** 主字段名(问题标题会写进这一列) */
  primaryField?: string
  /** 列名映射(本地标准列名 → 目标表实际列名) */
  fieldMap?: Record<string, string>
  /** 最近一轮拉取说明(如:目标表缺回写列,已跳过) */
  pullNote?: string
  /** 最近若干轮同步结果(最新在前,最多 20 条) */
  history?: Array<Record<string, unknown>>
  /** 证据明细同步配置 */
  evidence?: LarkEvidenceConfig
  /** 已推证据条数 */
  mappedEvidence?: number
  /** 证据最近一次推送结果 */
  lastEvidence?: LarkSyncOut | null
  /** 按当前上限,本轮还会推几条证据 */
  pendingEvidence?: number
  /** 已上传到 Base 的证据图片素材数(按 md5 去重) */
  mappedMedia?: number
  /** 已写进证据行的附件条数 */
  attachedEvidence?: number
  /** 多维表格名（UI 显示人话，不显示 token） */
  baseName?: string
  /** 议题表名 */
  issuesTableName?: string
  /** 同事能否回写（状态/跟进人/处理备注三列齐全） */
  canWriteBack?: boolean
  /** 人员列配置与映射状态 */
  person?: LarkPersonConfig
}

/** 议题证据明细同步配置(默认关闭:客户原文外发,保守优先) */
export interface LarkEvidenceConfig {
  enabled: boolean
  /** 收集范围(天) */
  days: number
  /** 每议题最多推几条(首现 1 条 + 最新若干) */
  maxPerIssue: number
  /** 每条内容截断字数 */
  maxChars: number
  /** 证据子表 id(未创建为空) */
  tableId: string
  /** 是否把证据的图片/视频传到「证据图」附件列(默认关:原图比文字更敏感) */
  media: boolean
  /** 单张图片上限(MB) */
  maxMediaMB: number
  /** 单轮最多上传几张(限流闸门) */
  maxUploadsPerRound: number
}

/** 一键升级表格：每一步的结果（created/skipped/failed） */
export interface LarkSystemUpgrade {
  ok: boolean
  error?: string
  steps: Array<{ label: string; action: 'created' | 'skipped' | 'failed'; detail?: string }>
  /** 飞书未开放接口、只能手动做的部分 */
  manual: string[]
}

/** 人员列（真正的飞书成员，可 @提醒/可被自动化识别） */
export interface LarkPersonConfig {
  enabled: boolean
  /** Base 里的列名 */
  field: string
  /** 已解析出映射的人数（含手工映射） */
  mapped: number
  /** 上次自动解析时间 */
  mappedAt: number
  /** 手工映射文本（每行「称呼=open_id」） */
  manual: string
}

/** 证据子表创建/校验结果 */
export interface LarkEvidenceSetup {
  ok: boolean
  error?: string
  tableId?: string
  created?: boolean
  fieldsAdded?: string[]
  /** 与议题表的关联字段是否建立成功(失败则退化为按议题ID分组) */
  linkOk?: boolean
  note?: string
  status?: LarkBaseStatus
}

/** 议题同步「预览/验证」结果(cs:lark:basePreview / baseVerify) */
export interface LarkBaseVerify {
  ok: boolean
  error?: string
  /** 预览模式:未做任何写入 */
  preview?: boolean
  appToken?: string
  appName?: string
  issuesTableId?: string
  /** 目标表名(可能是用户自己的表,也可能是自动建的「议题」) */
  issuesTableName?: string
  issuesTableCreated?: boolean
  repliesTableId?: string
  /** 目标表已有列 */
  existingFields?: string[]
  /** 将新建的列 */
  missingFields?: string[]
  /** 同名但类型不符(不改动,写入时才报错,故先讲清) */
  typeConflicts?: Array<{ name: string; want: number; got: number }>
  /** 主字段(标题写进这一列) */
  primaryField?: string
  /** 三列齐全 → 支持同事回写 */
  canWriteBack?: boolean
  notes?: string[]
  status?: LarkBaseStatus
}

/** 一次「议题 → Base」同步的结果 */
export interface LarkSyncOut {
  ok: boolean
  error?: string
  scanned: number
  created: number
  updated: number
  skipped: number
  failed: number
  /** 因列类型不符被跳过的列次数 */
  skippedFields?: number
  /** 证据附件:本轮写进附件列的条数 */
  mediaUploaded?: number
  /** 证据附件:复用已上传素材的条数 */
  mediaCached?: number
  /** 证据附件:被跳过的条数(非图片/超上限) */
  mediaSkipped?: number
  /** 证据附件:失败条数(下一轮重试) */
  mediaFailed?: number
  at: number
}

/** 一次「Base → 本地」拉取的结果（同事改的状态/跟进人） */
export interface LarkPullResult {
  ok: boolean
  error?: string
  scanned: number
  applied: number
  /** 冲突：本地更新更晚，保留本地 */
  skippedLocalWin: number
  unmatched: number
  at: number
}

/** 每日日报配置（设置页「飞书通知 → 每日日报」） */
export interface LarkDigestConfig {
  enabled: boolean
  /** HH:mm */
  time: string
  /** 是否附上数字员工（影子）昨日统计 */
  includeAgent: boolean
  /** 上次成功发送的日期 YYYY-MM-DD */
  lastDate: string
  /** 接收目标数（复用飞书通知的目标） */
  targets: number
}

/** 图片密钥本地推导结果（设置页「自动推导」） */
export interface DeriveImageKeysResult {
  ok: boolean
  error?: string
  /** 推导出的 XOR 密钥（0-255） */
  xorKey?: number
  /** XOR 是否通过 y === xorKey ^ 0xd9 自校验 */
  xorVerified?: boolean
  /** 投票一致度（多少份模板支持这个值） */
  xorVotes?: number
  templateCount?: number
  /** 传入的 AES 密钥是否被模板探测段验证通过 */
  aesVerified?: boolean
  aesProbeFile?: string
}
