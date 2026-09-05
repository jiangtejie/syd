import { tool, zodSchema, type Tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { findTool, type ToolDef, type ToolParamDecl } from '../chat/skills'
import { findSoftwareTool } from '../cap/software'
import type { WbToolGroup } from './types'
import { requestToolApproval } from './approval'

/**
 * 工作台工具注册表:产品原生能力 → AI SDK tool()。
 * - 高扩展:业务执行器沿用 chat/skills.ts 与 cap/software.ts 的 ToolDef(唯一实现),
 *   本层只负责“声明分组 + zod schema + 审批标记”;新增能力 = 注册 def + 加入分组;
 * - 账号上下文由引擎注入(ctx.wxid),不暴露给模型;
 * - v1 全部只读;危险(写/外部)工具通过 approval 表逐次人工确认。
 */

interface WbToolSpec {
  resolve: () => ToolDef | undefined
  approval: boolean
}

/** 引用行编号(本回合内跨工具累加,行号与模型看到的文本前缀一一对应) */
interface WbLineState {
  next: number
  max: number
}

/** 工具输出行 → 行级证据条目(引擎收集,供回答引用解析落库) */
export interface WbEvidenceRow {
  n: number
  tool: string
  /** 行原文(≤240 字快照) */
  line: string
}

/** 常驻组:微信业务(绑定账号) */
const BUSINESS_TOOLS = [
  'query_issues',
  'query_group_issues',
  'search_issue_history',
  'monitor_summary',
  'customer_lookup',
  'recent_messages',
  'list_team_members'
]

/** 常驻组:软件自身状态(无账号也可用) */
const SOFTWARE_TOOLS = [
  'software_status',
  'data_scope',
  'bi_stats',
  'export_preview',
  'im_channels_status'
]

export const WORKBENCH_TOOL_GROUPS: WbToolGroup[] = [
  {
    id: 'business',
    label: '微信业务查询:问题/监控/客户/消息/团队(需绑定账号)',
    tools: BUSINESS_TOOLS
  },
  { id: 'software', label: '软件状态:版本/账号/数据范围/统计/IM 状态', tools: SOFTWARE_TOOLS }
]

export function workbenchToolNames(): string[] {
  return [...BUSINESS_TOOLS, ...SOFTWARE_TOOLS]
}

function resolveSpec(name: string): WbToolSpec | null {
  if (BUSINESS_TOOLS.includes(name)) {
    return { resolve: () => findTool(name), approval: false }
  }
  if (SOFTWARE_TOOLS.includes(name)) {
    return { resolve: () => findSoftwareTool(name), approval: false }
  }
  return null
}

/** ToolParamDecl → zod(自动生成参数 schema;高扩展:def 声明即生效) */
function zodFromParams(
  params: Record<string, ToolParamDecl> | undefined
): ReturnType<typeof z.object> {
  const shape: Record<string, z.ZodType> = {}
  for (const [name, p] of Object.entries(params ?? {})) {
    let base: z.ZodType
    switch (p.type) {
      case 'number':
        base = z.number()
        break
      case 'boolean':
        base = z.boolean()
        break
      default:
        base = z.string()
    }
    if (p.desc) base = base.describe(p.desc)
    if (!p.required) base = base.optional()
    shape[name] = base
  }
  return z.object(shape)
}

function toolFromDef(
  name: string,
  def: ToolDef,
  wxid: string,
  sessionId: number,
  spec: WbToolSpec,
  approvalTimeoutMs: number,
  lines: WbLineState,
  onRow?: (row: WbEvidenceRow) => void
): Tool {
  return tool({
    description: def.description,
    inputSchema: zodSchema(zodFromParams(def.params)),
    execute: async (args) => {
      const input = (args ?? {}) as Record<string, unknown>
      if (spec.approval) {
        const ok = await requestToolApproval(
          sessionId,
          name,
          JSON.stringify(input).slice(0, 300),
          approvalTimeoutMs
        )
        if (!ok) return `工具 ${name} 未获确认(超时或被拒绝),已跳过。`
      }
      try {
        const result = await def.run({ wxid, sessionId: String(sessionId) }, input)
        const text = result ?? '(无返回)'
        return evidenceNumbered(name, text, lines, onRow)
      } catch (e) {
        return `工具执行失败:${e instanceof Error ? e.message : String(e)}`
      }
    }
  })
}

/** 证据溯源 MVP:多行工具结果为每行注入 [n] 前缀(模型据此引用,编号与回调行一致) */
function evidenceNumbered(
  tool: string,
  text: string,
  lines: WbLineState,
  onRow?: (row: WbEvidenceRow) => void
): string {
  const parts = text.split('\n')
  const nonEmpty = parts.filter((p) => p.trim().length > 0)
  if (nonEmpty.length < 2) return text
  const out: string[] = []
  for (const raw of parts) {
    const t = raw.trim()
    if (!t) {
      out.push('')
      continue
    }
    if (lines.next <= lines.max) {
      out.push(`[${lines.next}] ${t}`)
      if (onRow) onRow({ n: lines.next, tool, line: t.slice(0, 240) })
      lines.next += 1
    } else {
      out.push(t)
    }
  }
  return out.join('\n')
}

/** 构建工作台 ToolSet(引擎每轮使用;wxid/sessionId 由引擎闭包注入) */
export function buildWorkbenchToolSet(
  wxid: string,
  sessionId: number,
  opts: { approvalTimeoutMs?: number; onEvidenceRow?: (row: WbEvidenceRow) => void } = {}
): ToolSet {
  const timeout = opts.approvalTimeoutMs ?? 60_000
  /** 本轮行号状态:跨工具累加(与模型看到的 [n] 前缀一致);上限 200 行 */
  const lines: WbLineState = { next: 1, max: 200 }
  const out: ToolSet = {}
  for (const name of workbenchToolNames()) {
    const spec = resolveSpec(name)
    if (!spec) continue
    const def = spec.resolve()
    if (!def) continue
    out[name] = toolFromDef(name, def, wxid, sessionId, spec, timeout, lines, opts.onEvidenceRow)
  }
  return out
}

/** 固定能力菜单(注入 system,跨轮不变;prompt-cache 友好) */
export function buildToolMenuText(): string {
  const lines = WORKBENCH_TOOL_GROUPS.map((g) => `- ${g.id}:${g.label}`)
  return `可用能力(按组,工具由系统原生提供):
${lines.join('\n')}
需要数据时直接调用对应工具;列表外能力不可用。`
}
