import { listFeedbackIssues } from '../../feedback/analyzer'
import { listIssuesByGroup, searchIssues } from '../../../db/repos/issueRepo'
import { listTeamMembers } from '../../../db/repos/teamRepo'
import { getSessions, getMessages } from '../../wechat/wxService'
import type { ChatMessage } from '../../../../shared/types'

/**
 * AI 助手工具注册表(内置业务 skill)。
 * 全部只读(group_analyze 类写操作不开放);输出统一截断;发送保持人工闸门。
 * MCP(P1)将注册为 kind:'mcp' 的同一形态工具。
 */

export interface ToolCtx {
  wxid: string
  /** 当前正在对话的微信会话 id(群聊时用于读取该群问题/消息) */
  sessionId?: string
}

/** 轻量参数声明(原生 function-calling 生成精确 JSON Schema;JSON 协议仍靠 description) */
export interface ToolParamDecl {
  type?: 'string' | 'number' | 'boolean'
  required?: boolean
  desc?: string
}

export interface ToolDef {
  name: string
  kind: 'builtin' | 'skill' | 'mcp'
  /** 给 LLM 的描述(含 args 示例) */
  description: string
  /** 参数声明(可选;缺省则原生通道给宽松 object schema) */
  params?: Record<string, ToolParamDecl>
  /** 需要人工确认后执行(发消息/外部写类) */
  confirm?: boolean
  /** 依赖微信账号上下文:wxid 为空的会话(IM 等外部渠道)执行时返回占位说明 */
  needsWx?: boolean
  run: (ctx: ToolCtx, args: Record<string, unknown>) => Promise<string>
}

/** 由轻量声明生成 OpenAI function-calling 参数 schema */
export function schemaFromParams(
  params: Record<string, ToolParamDecl> | undefined
): Record<string, unknown> {
  if (!params || Object.keys(params).length === 0) {
    return { type: 'object', additionalProperties: true }
  }
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [name, p] of Object.entries(params)) {
    const prop: Record<string, unknown> = {}
    if (p.type) prop.type = p.type
    if (p.desc) prop.description = p.desc
    properties[name] = prop
    if (p.required) required.push(name)
  }
  const schema: Record<string, unknown> = { type: 'object', properties }
  if (required.length > 0) schema.required = required
  return schema
}

const MAX_TEXT = 4000

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…(已截断)` : text
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(
    2,
    '0'
  )} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 单条微信消息转可读文本(助手展示用,不依赖解析对象内部形态) */
function msgText(m: ChatMessage): string {
  const p = m.parsedContent
  if (typeof p === 'string') return p || '[文本]'
  if (p && typeof p === 'object') {
    const t = (p as { text?: unknown }).text
    if (typeof t === 'string' && t) return t
  }
  if (m.localType === 3) return '[图片]'
  if (m.localType === 34) return '[语音]'
  if (m.localType === 43) return '[视频]'
  if (m.localType === 47) return '[表情]'
  return '[消息]'
}

function issueLine(
  it: {
    status: string
    type: string
    severity?: string
    needConfirm?: boolean
    title: string
    occurAt: number
    groupName?: string
    groupUsername?: string
    msgCount?: number
    assignee?: string
    autoDone?: boolean
    followUp?: boolean
  },
  withGroup: boolean
): string {
  const st =
    it.status === 'open'
      ? it.needConfirm
        ? '疑似'
        : it.followUp
          ? '跟进中'
          : '待处理'
      : it.status === 'done'
        ? `已解决${it.autoDone ? '(自动)' : ''}`
        : it.status === 'stalled'
          ? '已搁置'
          : '已归档'
  const sev = it.severity && it.severity !== '一般' ? `【${it.severity}】` : ''
  const g = withGroup ? `(群:${it.groupName || it.groupUsername || '-'})` : ''
  return `- [${st}] ${sev}${it.type} ${it.title} ${g} 首现 ${fmtTime(it.occurAt)}${
    it.msgCount ? `,${it.msgCount} 条证据` : ''
  }${it.assignee ? `,跟进人已指派` : ''}`
}

export const BUILTIN_TOOLS: ToolDef[] = [
  {
    name: 'query_issues',
    kind: 'builtin',
    needsWx: true,
    params: {
      q: { type: 'string', desc: '关键词(标题/摘要/类型)' },
      status: { type: 'string', desc: 'open|done|stalled|archived' },
      severity: { type: 'string', desc: '紧急|高|一般' },
      limit: { type: 'number', desc: '最多返回条数(1-15)' }
    },
    description:
      '按关键词/类型/状态/严重度查询本账号记录的问题(监控/群问题同源)。' +
      'args: {"q":"关键词(可空)","status":"open|done|stalled|archived(可空)","severity":"紧急|高|一般(可空)","limit":5}',
    run: async (ctx, args) => {
      const limit = Math.min(Math.max(Math.floor(Number(args.limit) || 5), 1), 15)
      const q = String(args.q || '').trim()
      let list = listFeedbackIssues(ctx.wxid)
      const status = String(args.status || '')
      if (status) list = list.filter((i) => i.status === status)
      const sev = String(args.severity || '')
      if (sev) list = list.filter((i) => (i.severity ?? '一般') === sev)
      if (q) {
        const k = q.toLowerCase()
        list = list.filter(
          (i) =>
            i.title.toLowerCase().includes(k) ||
            (i.summary ?? '').toLowerCase().includes(k) ||
            i.type.includes(q)
        )
      }
      if (list.length === 0) return '没有匹配的问题记录。'
      return list
        .slice(0, limit)
        .map((it) => issueLine(it, true))
        .join('\n')
    }
  },
  {
    name: 'query_group_issues',
    kind: 'builtin',
    needsWx: true,
    params: {
      group: { type: 'string', desc: '群 username(空=当前会话)' },
      limit: { type: 'number', desc: '最多返回条数(1-15)' }
    },
    description:
      '读取指定群(或当前聊天对象)记录的问题,待处理优先。' +
      'args: {"group":"群username(可空,空=当前会话)","limit":8}',
    run: async (ctx, args) => {
      const group = String(args.group || '') || ctx.sessionId || ''
      if (!group || !group.includes('@chatroom')) {
        return '未指定有效群会话(需 @chatroom 形式的 username)。'
      }
      const limit = Math.min(Math.max(Math.floor(Number(args.limit) || 8), 1), 15)
      const issues = listIssuesByGroup(ctx.wxid, group)
      if (issues.length === 0) return '该群近期没有记录到问题。'
      const score: Record<string, number> = { open: 0, stalled: 1, done: 2, archived: 3 }
      return issues
        .sort((a, b) => score[a.status] - score[b.status] || b.occurAt - a.occurAt)
        .slice(0, limit)
        .map((it) => issueLine(it, false))
        .join('\n')
    }
  },
  {
    name: 'search_issue_history',
    kind: 'builtin',
    needsWx: true,
    params: {
      q: { type: 'string', required: true, desc: '搜索关键词' },
      limit: { type: 'number', desc: '最多返回条数(1-10)' }
    },
    description:
      '关键词搜索历史客户问题(跨群),用于判断客户是否提过类似诉求、上次怎么处理。' +
      'args: {"q":"关键词","limit":5}',
    run: async (ctx, args) => {
      const q = String(args.q || '').trim()
      if (!q) return '缺少关键词 q。'
      const limit = Math.min(Math.max(Math.floor(Number(args.limit) || 5), 1), 10)
      const issues = searchIssues(ctx.wxid, q, limit)
      if (issues.length === 0) return `没有找到与「${q}」相关的历史问题。`
      return issues.map((it) => issueLine(it, true)).join('\n')
    }
  },
  {
    name: 'list_team_members',
    kind: 'builtin',
    needsWx: true,
    description: '列出已标记的团队客服成员名单(我方同事,其发言不是客户诉求)。args: {}',
    run: async (ctx) => {
      const members = listTeamMembers(ctx.wxid)
      if (members.length === 0) return '当前没有标记任何团队客服成员。'
      return members
        .map((m) => `- ${m.label || m.username}${m.label ? `（${m.username}）` : ''}`)
        .join('\n')
    }
  },
  {
    name: 'monitor_summary',
    kind: 'builtin',
    needsWx: true,
    params: { limit: { type: 'number', desc: '最多列出关注条目数' } },
    description:
      '读取问题监控概览(正式口径,排除疑似):待处理/跟进中/跟进超时/紧急与高危数/今日新增/疑似数,并列出最需关注的若干条。args: {"limit":5}',
    run: async (ctx, args) => {
      const limit = Math.min(Math.max(Math.floor(Number(args.limit) || 5), 1), 10)
      const all = listFeedbackIssues(ctx.wxid)
      const formal = all.filter((i) => !i.needConfirm)
      const open = formal.filter((i) => i.status === 'open')
      const urgent = open.filter((i) => i.severity === '紧急')
      const high = open.filter((i) => i.severity === '高')
      const followOverdue = open.filter((i) => i.followUpOverdue)
      const pending = open.filter((i) => !i.followUp)
      const following = open.filter((i) => i.followUp && !i.followUpOverdue)
      const doubt = all.filter((i) => i.needConfirm && i.status === 'open')
      const dayStart = new Date()
      dayStart.setHours(0, 0, 0, 0)
      const todayNew = formal.filter((i) => i.createdAt >= dayStart.getTime()).length
      const lines = [
        `待处理(未回复) ${pending.length} 条;跟进中 ${following.length} 条;跟进超时 ${followOverdue.length} 条;`,
        `紧急待办 ${urgent.length} 条;高危 ${high.length} 条;今日新增 ${todayNew} 条;疑似待确认 ${doubt.length} 条。`
      ]
      const focus = [...urgent, ...high, ...followOverdue]
      if (focus.length > 0) {
        lines.push('最需关注:')
        const seen = new Set<number>()
        for (const it of [...urgent, ...high, ...followOverdue]) {
          if (seen.has(it.id)) continue
          seen.add(it.id)
          lines.push(issueLine(it, true))
          if (lines.length >= limit + 4) break
        }
      }
      return lines.join('\n')
    }
  },
  {
    name: 'customer_lookup',
    kind: 'builtin',
    needsWx: true,
    params: { name: { type: 'string', desc: '客户名称或 username(空=当前会话对象)' } },
    description:
      '按名称或 username 查询客户/群资料(微信会话派生):显示名/备注/未读/最后消息时间/消息摘要。' +
      'args: {"name":"客户名称或username(可空,空=当前会话对象)"}',
    run: async (ctx, args) => {
      const res = getSessions(ctx.wxid)
      if (!res.ok || !res.sessions) return '无法读取会话列表(账号未连接或数据未就绪)。'
      const name = String(args.name || '')
        .trim()
        .toLowerCase()
      const session =
        (name
          ? res.sessions.find(
              (s) =>
                (s.displayName || '').toLowerCase() === name ||
                (s.nickname || '').toLowerCase() === name ||
                (s.remark || '').toLowerCase() === name ||
                s.username.toLowerCase() === name
            )
          : ctx.sessionId
            ? res.sessions.find((s) => s.username === ctx.sessionId)
            : undefined) || undefined
      if (!session) {
        return name ? `未找到与「${name}」匹配的会话。` : '未指定名称且当前不在会话中。'
      }
      return [
        `- 显示名:${session.displayName || session.username}`,
        session.nickname ? `- 昵称:${session.nickname}` : '',
        session.remark ? `- 备注:${session.remark}` : '',
        `- 类型:${session.isGroup ? '群聊' : session.isOfficialAccount ? '公众号' : '个人'}${
          session.isWeCom ? '(企微)' : ''
        }`,
        `- 未读 ${session.unreadCount} 条;最后消息时间 ${fmtTime(session.lastTimestamp)}`,
        session.summary ? `- 最近消息摘要:${session.summary}` : ''
      ]
        .filter(Boolean)
        .join('\n')
    }
  },
  {
    name: 'recent_messages',
    kind: 'builtin',
    needsWx: true,
    params: {
      sessionId: { type: 'string', desc: '会话 username(空=当前会话)' },
      limit: { type: 'number', desc: '最近 N 条(1-30)' }
    },
    description:
      '读取指定会话(或当前聊天对象)最近消息文本,用于了解刚发生/正在讨论的内容。' +
      'args: {"sessionId":"会话username(可空,空=当前会话)","limit":10}',
    run: async (ctx, args) => {
      const sessionId = String(args.sessionId || '') || ctx.sessionId || ''
      if (!sessionId) return '未指定会话。'
      const limit = Math.min(Math.max(Math.floor(Number(args.limit) || 10), 1), 30)
      const res = getMessages(ctx.wxid, sessionId, limit)
      if (!res.ok || !res.messages || res.messages.length === 0) return '该会话暂无消息。'
      return res.messages
        .map((m) => {
          const who = m.isSend ? '我方' : m.senderNickname || m.senderUsername || '未知'
          const t = new Date(m.createTime)
          const hm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(
            2,
            '0'
          )}`
          return `${hm} ${who}: ${msgText(m)}`
        })
        .join('\n')
    }
  }
]

export const ALL_TOOLS: ToolDef[] = BUILTIN_TOOLS

export function findTool(name: string): ToolDef | undefined {
  return ALL_TOOLS.find((t) => t.name === name)
}

/** 工具说明文本(注入系统提示;ReAct 式:先思考→再行动或直接回答) */
export function toolInstructionsText(): string {
  return (
    '工作方式(ReAct 思考循环):\n' +
    '1. 判断:先想清楚“是否需要业务数据/能否直接回答”。需要调用工具时,输出必须以一行「思考:」开头(≤80字,说明为什么需要该工具与怎么用),随后单独输出 JSON:{"tool":"工具名","args":{...}};\n' +
    '2. 观察:工具结果会以 [工具结果] 回填,先判断结果是否足够,再决定继续调用/换工具/修正参数/直接输出最终回答;\n' +
    '3. 无需工具时直接输出最终回答(不要输出思考行,也不要输出 JSON)。\n' +
    ALL_TOOLS.map((t) => `- ${t.name}:${t.description}`).join('\n')
  )
}

/** 执行工具并裁剪输出;未知工具返回错误说明供模型修正 */
export async function runTool(
  ctx: ToolCtx,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const tool = findTool(name)
  if (!tool) {
    return `未知工具:${name}。可用工具:${ALL_TOOLS.map((t) => t.name).join('、')}`
  }
  try {
    return clip(await tool.run(ctx, args ?? {}))
  } catch (e) {
    return `工具执行失败:${e instanceof Error ? e.message : String(e)}`
  }
}
