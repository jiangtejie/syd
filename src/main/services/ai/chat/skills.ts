import { listFeedbackIssues } from '../../feedback/analyzer'
import {
  listIssuesByGroup,
  searchIssues,
  setIssueAssignee,
  setIssueStatus
} from '../../../db/repos/issueRepo'
import { listTeamMembers } from '../../../db/repos/teamRepo'
import { issueStatusLabel } from '../issueLabel'
import { getSessions, getMessages } from '../../wechat/wxService'
import { enqueueSend } from '../../send/sendService'
import { fmtStamp } from '../../../../shared/monitorMetrics'
import { sendAgentEnabled } from '../sendGate'
import type { ChatMessage } from '../../../../shared/types'

/**
 * AI 助手工具注册表(内置业务 skill)。
 * 查询工具全部只读;唯一写工具 send_message 需人工确认(总开关/审批开关见 sendGate)。
 * MCP(P1)将注册为 kind:'mcp' 的同一形态工具。
 */

export interface ToolCtx {
  wxid: string
  /** 当前正在对话的微信会话 id(群聊时用于读取该群问题/消息) */
  sessionId?: string
  /**
   * 本轮的取消信号（用户点「停止」时中止）。
   *
   * 为什么工具要拿到它：LLM 流的 abort 只能停住「模型还在说话」这一段；
   * 生图 / 子模型调用 / 封面渲染这类**工具内部的慢动作**不接信号的话，
   * 用户点了停止还要干等十几秒到两分钟 —— 实测就是「点了停止没停」。
   */
  signal?: AbortSignal
}

/** 轻量参数声明(原生 function-calling 生成精确 JSON Schema;JSON 协议仍靠 description) */
export interface ToolParamDecl {
  type?: 'string' | 'number' | 'boolean' | 'enum' | 'number_array' | 'string_array' | 'json'
  required?: boolean
  desc?: string
  /** type='enum' 时的可选值 */
  enum?: string[]
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
    // 无声明:仅声明 object 类型即可。不写 additionalProperties(true),
    // 部分 OpenAI 兼容网关会拒绝显式的 additionalProperties 字段(400)。
    return { type: 'object' }
  }
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [name, p] of Object.entries(params)) {
    const prop: Record<string, unknown> = {}
    if (p.type === 'enum') {
      prop.type = 'string'
      if (p.enum && p.enum.length > 0) prop.enum = p.enum
    } else if (p.type === 'number_array') {
      prop.type = 'array'
      prop.items = { type: 'number' }
    } else if (p.type === 'string_array') {
      prop.type = 'array'
      prop.items = { type: 'string' }
    } else if (p.type) {
      prop.type = p.type
    }
    if (p.desc) prop.description = p.desc
    properties[name] = prop
    if (p.required) required.push(name)
  }
  const schema: Record<string, unknown> = { type: 'object', properties }
  if (required.length > 0) schema.required = required
  return schema
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
    followUpOverdue?: boolean
    archivedFrom?: string
  },
  withGroup: boolean
): string {
  const sev = it.severity && it.severity !== '一般' ? `【${it.severity}】` : ''
  const g = withGroup ? `(群:${it.groupName || it.groupUsername || '-'})` : ''
  return `- [${issueStatusLabel(it)}] ${sev}${it.type} ${it.title} ${g} 首现 ${fmtStamp(it.occurAt)}${
    it.msgCount ? `,${it.msgCount} 条证据` : ''
  }${it.assignee ? `,跟进人 ${it.assignee}` : ',未指派'}`
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
        `- 未读 ${session.unreadCount} 条;最后消息时间 ${fmtStamp(session.lastTimestamp)}`,
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
          )}:${String(t.getSeconds()).padStart(2, '0')}`
          return `${hm} ${who}: ${msgText(m)}`
        })
        .join('\n')
    }
  },
  {
    name: 'send_message',
    kind: 'builtin',
    needsWx: true,
    confirm: true,
    params: {
      target: { type: 'string', required: true, desc: '接收方:客户/群的显示名或 username' },
      text: { type: 'string', required: true, desc: '要发送的文本内容(≤2000 字)' }
    },
    description:
      '向指定客户/群发送一条文本消息(写操作,执行前需人工确认;受发送频控/熔断/审计约束)。' +
      'target 用客户或群的显示名/备注/昵称或 username(不确定时先用 customer_lookup/recent_messages 确认)。' +
      'args: {"target":"客户显示名","text":"消息内容"}',
    run: async (ctx, args) => {
      if (!sendAgentEnabled()) {
        return '智能体发送未开启(设置 → 发送 → 智能体发送开关)。请告知用户需先在软件中开启。'
      }
      const target = String(args.target || '').trim()
      const text = String(args.text || '').trim()
      if (!target) return '缺少参数 target(接收方)。'
      if (!text) return '缺少参数 text(消息内容)。'
      if (text.length > 2000) return 'text 过长(最多 2000 字),请精简后重试。'
      if (!(ctx.wxid || '').trim()) return '当前未绑定微信账号,无法发送消息。'
      const res = getSessions(ctx.wxid)
      if (!res.ok || !res.sessions) {
        return '无法读取会话列表(账号未连接或数据未就绪),暂不能发送。'
      }
      const k = target.toLowerCase()
      const hit = res.sessions.find(
        (s) =>
          (s.displayName || '').toLowerCase() === k ||
          (s.nickname || '').toLowerCase() === k ||
          (s.remark || '').toLowerCase() === k ||
          s.username.toLowerCase() === k
      )
      if (!hit) {
        const names = res.sessions
          .slice(0, 60)
          .filter((s) =>
            ((s.displayName || '') + (s.remark || '') + (s.nickname || ''))
              .toLowerCase()
              .includes(k)
          )
          .slice(0, 3)
          .map((s) => s.displayName || s.username)
        return `未找到会话「${target}」。${names.length > 0 ? `相近的会话:${names.join('、')}` : '可先用 customer_lookup 确认名称后重试。'}`
      }
      const targetName = hit.displayName || hit.remark || hit.nickname || hit.username
      const r = await enqueueSend({
        wxid: ctx.wxid,
        sessionId: hit.username,
        targetName,
        text,
        mode: 'confirm',
        source: 'agent'
      })
      if (r.ok && r.status === 'sent') {
        return `已发送给「${targetName}」${r.verified ? '(校验通过)' : '(待校验)'}。`
      }
      return `发送失败:${r.error ?? '未知原因'}`
    }
  },

  /* ── 问题处理(写操作;执行前按「工具审批策略」确认,完全访问模式直通) ── */

  {
    name: 'resolve_issue',
    kind: 'builtin',
    needsWx: true,
    confirm: true,
    params: {
      issue_id: {
        type: 'number',
        required: true,
        desc: '问题 id(来自 query_issues/monitor_summary)'
      },
      note: { type: 'string', desc: '处理说明(可空)' }
    },
    description:
      '把一条问题标记为「已解决」(写操作,需按审批策略确认)。' +
      'args: {"issue_id":12,"note":"已电话沟通"}',
    run: async (ctx, args) => {
      const id = Number(args?.issue_id)
      if (!Number.isFinite(id) || id <= 0) return '缺少参数 issue_id(问题 id)。'
      let hit: { type: string; title: string } | null = null
      try {
        hit = listFeedbackIssues(ctx.wxid).find((i) => i.id === id) ?? null
      } catch {
        /* 读取失败不影响标记 */
      }
      setIssueStatus(id, 'done')
      const note = String(args?.note ?? '').trim()
      return `问题 #${id}${hit ? `(${hit.type} ${hit.title})` : ''} 已标记为已解决${note ? `,说明:${note}` : ''}。`
    }
  },
  {
    name: 'stall_issue',
    kind: 'builtin',
    needsWx: true,
    confirm: true,
    params: {
      issue_id: { type: 'number', required: true, desc: '问题 id' },
      note: { type: 'string', desc: '搁置原因(可空)' }
    },
    description:
      '把一条问题标记为「已搁置」(写操作,需按审批策略确认)。args: {"issue_id":12,"note":"客户暂不需要"}',
    run: async (_ctx, args) => {
      const id = Number(args?.issue_id)
      if (!Number.isFinite(id) || id <= 0) return '缺少参数 issue_id(问题 id)。'
      setIssueStatus(id, 'stalled')
      const note = String(args?.note ?? '').trim()
      return `问题 #${id} 已标记为已搁置${note ? `,原因:${note}` : ''}。`
    }
  },
  {
    name: 'assign_issue',
    kind: 'builtin',
    needsWx: true,
    confirm: true,
    params: {
      issue_id: { type: 'number', required: true, desc: '问题 id' },
      assignee: { type: 'string', desc: '跟进人 username(来自 list_team_members);传空串=取消指派' }
    },
    description:
      '指派/取消问题的跟进人(写操作,需按审批策略确认);跟进人须是团队名单里的 username。' +
      'args: {"issue_id":12,"assignee":"zhangsan"}',
    run: async (_ctx, args) => {
      const id = Number(args?.issue_id)
      if (!Number.isFinite(id) || id <= 0) return '缺少参数 issue_id(问题 id)。'
      const who = String(args?.assignee ?? '').trim()
      const ok = setIssueAssignee(id, who || null)
      if (!ok) return `问题 #${id} 不存在。`
      return who ? `问题 #${id} 已指派给 ${who}。` : `问题 #${id} 已取消指派。`
    }
  }
]

export const ALL_TOOLS: ToolDef[] = BUILTIN_TOOLS

export function findTool(name: string): ToolDef | undefined {
  return ALL_TOOLS.find((t) => t.name === name)
}
