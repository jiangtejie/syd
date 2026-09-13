import { listIssuesByGroup, searchIssues } from '../../db/repos/issueRepo'
import { clipMultiline } from '../../util/text'
import { listTeamMembers } from '../../db/repos/teamRepo'
import { issueStatusLabel } from './issueLabel'
import { fmtStamp } from '../../../shared/monitorMetrics'

/**
 * 建议 Agent 只读工具面（迷你自研 Agent 层的工具注册表）。
 * 全部工具只读、毫秒级本地执行；不暴露发送/写入能力（发送保持人工闸门）。
 * 工具输出会被截断后回填给 LLM 继续推理。
 */

export interface AgentToolCtx {
  wxid: string
  /** 当前会话 id（群会话时用于读群问题；可为空字符串表示私聊） */
  sessionId?: string
}

export interface AgentTool {
  name: string
  /** 给 LLM 的描述（含参数格式），拼进提示词 */
  schema: string
  /** 本地执行（须同步或返回 Promise） */
  run: (ctx: AgentToolCtx, args: Record<string, unknown>) => Promise<string>
}

export const SUGGEST_TOOLS: AgentTool[] = [
  {
    name: 'read_group_issues',
    schema:
      '读取当前群近期的运营问题（待处理优先，含已解决最近 3 条）。' +
      'args: {"limit": 5}。仅当消息发生在群里且需要了解群里待办/客诉背景时调用。',
    run: async (ctx, args) => {
      if (!ctx.sessionId || !ctx.sessionId.includes('@chatroom')) {
        return '当前会话不是群聊，无需该工具。'
      }
      const limit = Math.min(Math.max(Math.floor(Number(args.limit) || 5), 1), 10)
      const score: Record<string, number> = { open: 0, stalled: 1, done: 2, archived: 3 }
      const issues = listIssuesByGroup(ctx.wxid, ctx.sessionId)
        .sort((a, b) => score[a.status] - score[b.status] || b.occurAt - a.occurAt)
        .slice(0, limit)
      if (issues.length === 0) return '该群近期没有记录到问题。'
      return issues
        .map((it) => {
          const owner = it.assignee ? `，跟进人 ${it.assignee}` : '，未指派'
          return `- [${issueStatusLabel(it)}] ${it.type} ${it.title}（首现 ${fmtStamp(it.occurAt)}，${it.msgCount} 条证据${owner}）`
        })
        .join('\n')
    }
  },
  {
    name: 'search_issues',
    schema:
      '按关键词搜索本账号记录过的客户问题（标题/摘要），用于判断客户是否提过类似诉求、上次怎么处理的。' +
      'args: {"q": "关键词", "limit": 5}',
    run: async (ctx, args) => {
      const q = String(args.q || '').trim()
      if (!q) return '缺少关键词 q。'
      const limit = Math.min(Math.max(Math.floor(Number(args.limit) || 5), 1), 10)
      const issues = searchIssues(ctx.wxid, q, limit)
      if (issues.length === 0) return `没有找到与「${q}」相关的历史问题。`
      return issues
        .map((it) => {
          const g = it.groupName || it.groupUsername
          return `- [${issueStatusLabel(it)}] ${it.type} ${it.title}（群 ${g}，首现 ${fmtStamp(it.occurAt)}）`
        })
        .join('\n')
    }
  },
  {
    name: 'list_team_members',
    schema: '列出已全局标记的团队客服成员（我方同事，他们的发言不是客户诉求）。args: {}',
    run: async (ctx) => {
      const members = listTeamMembers(ctx.wxid)
      if (members.length === 0) return '当前没有标记任何团队客服成员。'
      return members
        .map((m) => `- ${m.label || m.username}${m.label ? `（${m.username}）` : ''}`)
        .join('\n')
    }
  }
]

/** 按名称执行工具（未知工具返回错误说明，让 LLM 修正/降级） */
export async function runSuggestionTool(
  ctx: AgentToolCtx,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const tool = SUGGEST_TOOLS.find((t) => t.name === name)
  if (!tool) return `未知工具：${name}。可用工具：${SUGGEST_TOOLS.map((t) => t.name).join('、')}`
  try {
    return clipMultiline(await tool.run(ctx, args ?? {}), 4000)
  } catch (e) {
    return `工具执行失败：${e instanceof Error ? e.message : String(e)}`
  }
}

/** 工具说明文本（注入首轮提示词；列表为空时为空串） */
export function toolsInstructionText(): string {
  if (SUGGEST_TOOLS.length === 0) return ''
  return (
    '可选上下文工具（只读，毫秒级；仅当你需要这些信息才能写好回复时调用，否则直接输出候选）：\n' +
    SUGGEST_TOOLS.map(
      (t) => `- 工具名 ${t.name}：${t.schema} 调用时输出 JSON：{"tool":"${t.name}","args":{...}}`
    ).join('\n') +
    '\n工具结果会以「工具 x 返回:」的形式附加后再让你输出最终候选。'
  )
}

/**
 * 本地已知背景（零 LLM 成本，注入用户提示词）：
 * - 群会话：本群待处理问题（前 5 条）与最近已解决（前 2 条）；
 * - 团队客服成员名单（避免把同事发言当客户诉求）。
 */
export function collectLocalFacts(ctx: AgentToolCtx): string {
  const parts: string[] = []
  if (ctx.sessionId?.includes('@chatroom')) {
    const issues = listIssuesByGroup(ctx.wxid, ctx.sessionId)
    const open = issues.filter((i) => i.status === 'open').slice(0, 5)
    const doneRecent = issues
      .filter((i) => i.status === 'done')
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 2)
    if (open.length > 0) {
      parts.push(
        `本群待处理问题：\n` +
          open
            .map(
              (it) =>
                `- [${it.type}] ${it.title}${it.summary ? `（${it.summary.slice(0, 40)}…）` : ''}`
            )
            .join('\n')
      )
    }
    if (doneRecent.length > 0) {
      parts.push(
        `本群最近已解决问题（供口径参考）：\n` +
          doneRecent.map((it) => `- ${it.type} ${it.title}`).join('\n')
      )
    }
  }
  const members = listTeamMembers(ctx.wxid)
  if (members.length > 0) {
    parts.push(
      `团队客服成员（他们的发言是内部沟通，不是客户诉求）：${members
        .map((m) => (m.label ? `${m.label}(${m.username})` : m.username))
        .join('、')}`
    )
  }
  return parts.join('\n')
}
