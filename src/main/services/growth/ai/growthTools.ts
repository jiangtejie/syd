import { tool, zodSchema, type ToolSet } from 'ai'
import { zodFromParams } from '../../ai/toolSchema'
import { requestToolApproval } from '../../ai/workbench/approval'
import { growthToolDefs } from './growthToolDefs'
import { createLogger } from '../../logging'

const log = createLogger('growth-ai')

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
  /** 本轮的取消信号（用户点「停止」）：工具内部的慢动作（生图 / 子模型 / 封面）靠它立刻收手 */
  signal?: AbortSignal
}

export { itemBrief, storeBrief, brandBrief } from './growthToolDefs'

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
            120_000,
            ctx.signal
          )
          if (ctx.signal?.aborted) return '已取消：用户停止了本轮生成，本次没有产生任何产出。'
          if (!ok) return '用户拒绝了本次操作, 请说明原因或换一种方式。'
        }
        // 已经取消就别再动手了（模型可能在同一轮里连续发好几个工具调用）
        if (ctx.signal?.aborted) return '已取消：用户停止了本轮生成，本次没有产生任何产出。'
        try {
          const result = await def.run(
            { wxid: '', sessionId: String(ctx.sessionId), signal: ctx.signal },
            input
          )
          return result ?? '(无返回)'
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          // 用户点了停止：这是预期结果，不是故障 —— 别记 warn，也别报「工具执行失败」
          if (ctx.signal?.aborted) {
            return '已取消：用户停止了本轮生成，本次没有产生任何产出。'
          }
          // 必须落日志：工具异常此前只作为字符串回给模型，日志里一行都没有 ——
          // 出问题时唯一的记录是模型自己的复述（实测被它讲成「后端任务没落库」）。
          log.warn(
            'tool ' +
              def.name +
              ' failed (task=' +
              String(ctx.taskId) +
              '): ' +
              msg +
              ' args=' +
              JSON.stringify(input).slice(0, 300)
          )
          // 约束类错误（老库形状没跟上代码演进）给一句能自救的话，别让模型对着
          // "NOT NULL constraint failed: xxx.yyy" 自己编流程
          const hint = /NOT NULL constraint failed|no such column|has no column named/i.test(msg)
            ? '（本地数据表结构与当前版本不一致：请重启应用以完成数据库迁移，然后重试这一步）'
            : ''
          return '工具执行失败:' + msg + hint
        }
      }
    })
  }
  return out
}
