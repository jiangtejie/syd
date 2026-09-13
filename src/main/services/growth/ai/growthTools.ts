import { tool, zodSchema, type ToolSet } from 'ai'
import { zodFromParams } from '../../ai/toolSchema'
import { requestToolApproval } from '../../ai/workbench/approval'
import { growthToolDefs } from './growthToolDefs'

/**
 * 营销域工具 → AI SDK tool() 的适配层（营销页的 AI 工作台用）。
 *
 * 工具实现与参数声明都在 ./growthToolDefs.ts + ./toolMeta.ts（与能力注册表共用同一份声明）；
 * 本文件只做三件事：
 *   1. 把「当前任务上下文」作为参数默认值注入（模型不传 contentId 时用当前任务素材）；
 *   2. 把 `confirm: true` 的写操作接到审批桥（与工作台同一套 `requestToolApproval`，120s 超时）；
 *   3. 保留 itemBrief / storeBrief 的对外导出（growthEngine 的 system 提示用）。
 */

export interface GrowthToolCtx {
  sessionId: number
  taskId: number
  contentId: number
  storeId: number | null
}

export { itemBrief, storeBrief } from './growthToolDefs'

export function buildGrowthToolSet(ctx: GrowthToolCtx): ToolSet {
  const defs = growthToolDefs({
    taskId: ctx.taskId,
    contentId: ctx.contentId,
    storeId: ctx.storeId
  })
  const out: ToolSet = {}
  for (const def of defs) {
    out[def.name] = tool({
      description: def.description,
      inputSchema: zodSchema(zodFromParams(def.params)),
      execute: async (args) => {
        const input = (args ?? {}) as Record<string, unknown>
        if (def.confirm) {
          const ok = await requestToolApproval(
            ctx.sessionId,
            def.name,
            JSON.stringify(input).slice(0, 500),
            120_000
          )
          if (!ok) return '用户拒绝了本次操作, 请说明原因或换一种方式。'
        }
        try {
          const result = await def.run({ wxid: '', sessionId: String(ctx.sessionId) }, input)
          return result ?? '(无返回)'
        } catch (e) {
          return '工具执行失败:' + (e instanceof Error ? e.message : String(e))
        }
      }
    })
  }
  return out
}
