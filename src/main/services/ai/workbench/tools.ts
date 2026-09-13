import { tool, zodSchema, type Tool, type ToolSet } from 'ai'
import { zodFromParams } from '../toolSchema'
import type { ToolDef } from '../chat/skills'
import { groupText, isWriteCap, listCaps, resolveCapDef, type CapGroup } from '../cap/registry'
import type { WbToolGroup } from './types'
import { requestToolApproval } from './approval'
import { sendAgentEnabled, sendApproveEnabled } from '../sendGate'

/**
 * 工作台工具注册表:产品原生能力 → AI SDK tool()。
 * - **唯一清单来自能力注册表**(cap/registry.ts):分组、停用、审批标记都从那里派生,
 *   新增能力只需在注册表登记,无需再改本文件(历史上这里有一份重复清单,已删除);
 * - 账号上下文由引擎注入(ctx.wxid),不暴露给模型;
 * - 写类工具(业务写 / 工作区写 / 云文档写)统一经审批桥,按「工具审批策略」判定直通或确认。
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

/** 工作台常驻能力:来自注册表(排除 L0 元技能与已停用能力) */
export function workbenchToolNames(): string[] {
  return listCaps()
    .filter((c) => c.tier > 0 && !c.disabled)
    .map((c) => c.name)
}

/** 分组菜单(给 system 的固定说明):按注册表分组聚合,新增能力自动出现 */
export function workbenchToolGroups(): WbToolGroup[] {
  const order: CapGroup[] = ['wechat', 'software', 'workspace', 'cloud', 'growth']
  const caps = listCaps().filter((c) => c.tier > 0 && !c.disabled)
  const out: WbToolGroup[] = []
  for (const g of order) {
    const items = caps.filter((c) => c.group === g)
    if (items.length === 0) continue
    const writes = items.filter((c) => isWriteCap(c.name)).length
    out.push({
      id: g,
      label: `${groupText(g)}(${items.length} 项${writes > 0 ? `,其中 ${writes} 项写操作需按审批策略确认` : ',只读'})`,
      tools: items.map((c) => c.name)
    })
  }
  return out
}

function resolveSpec(name: string): WbToolSpec | null {
  const def = resolveCapDef(name)
  if (!def) return null
  return { resolve: () => def, approval: isWriteCap(name) }
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
        if (name === 'send_message') {
          // 发送闸门:总开关关闭 → 直接不执行;审批开关关闭 → 跳过人工确认直通(仍走频控/审计)
          if (!sendAgentEnabled()) {
            return '智能体发送未开启(设置 → 发送 → 智能体发送开关),已跳过。'
          }
          if (!sendApproveEnabled()) {
            // 直通:不询问(仍走频控/审计)
          } else {
            const ok = await requestToolApproval(
              sessionId,
              name,
              JSON.stringify(input).slice(0, 300),
              approvalTimeoutMs
            )
            if (!ok) return `工具 ${name} 未获确认(超时或被拒绝),已跳过。`
          }
        } else {
          const ok = await requestToolApproval(
            sessionId,
            name,
            JSON.stringify(input).slice(0, 300),
            approvalTimeoutMs
          )
          if (!ok) return `工具 ${name} 未获确认(超时或被拒绝),已跳过。`
        }
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
  const lines = workbenchToolGroups().map((g) => `- ${g.id}:${g.label}`)
  return `可用能力(按组,工具由系统原生提供):
${lines.join('\n')}
需要数据时直接调用对应工具;列表外能力不可用。`
}
