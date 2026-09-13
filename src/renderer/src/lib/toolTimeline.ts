/**
 * 工具调用的时间线编排（**纯函数，零依赖**，可离线自检）。
 *
 * 为什么单独成文件：展示「顺序 vs 并行」靠的是**调用区间是否重叠**这一条规则，
 * 而不是猜；把规则写成纯函数后，自检能钉死这些分支（并行、串行、实时进行中、失败、缺时间戳的历史行），
 * 组件只负责画。
 */

export type ToolStatus = 'start' | 'done' | 'fail'

export interface TimelineItem {
  id: number | string
  name: string
  status: ToolStatus
  /** 收到 start 事件的时间戳（历史行没有 → 视为串行） */
  startedAt?: number
  /** 收到 done/fail 事件的时间戳 */
  endedAt?: number
  /** 调用参数（引擎已截断） */
  args?: string
  /** 调用结果（引擎已截断） */
  output?: string
  outTrunc?: boolean
}

export interface TimelineStep {
  /** 这一步里是否有并行调用（≥2 个区间重叠） */
  parallel: boolean
  items: TimelineItem[]
  startAt?: number
  endAt?: number
}

/** 一次调用的时长（进行中 = 到 now） */
export function itemDurationMs(item: TimelineItem, now: number): number | undefined {
  if (!item.startedAt) return undefined
  return Math.max(0, (item.endedAt ?? now) - item.startedAt)
}

/**
 * 把按事件顺序到达的调用编成「步」：
 * 后一个调用的开始时间落在当前步的结束时间之前 → 判为与当前步并行；
 * 否则开新的一步。没有时间戳（历史回看）时一律按串行处理。
 */
export function buildTimelineSteps(items: TimelineItem[], now = Date.now()): TimelineStep[] {
  const steps: TimelineStep[] = []
  for (const it of items) {
    const last = steps.length > 0 ? steps[steps.length - 1] : null
    const start = it.startedAt
    const end = it.endedAt ?? (it.status === 'start' ? now : start)
    const overlaps = !!last && !!start && !!last.endAt && start < last.endAt
    if (last && overlaps) {
      last.items.push(it)
      last.parallel = last.items.length > 1
      if (last.endAt === undefined || (end !== undefined && end > last.endAt)) last.endAt = end
      continue
    }
    steps.push({
      parallel: false,
      items: [it],
      startAt: start,
      endAt: end ?? undefined
    })
  }
  return steps
}

export interface TimelineSummary {
  calls: number
  steps: number
  parallelSteps: number
  running: number
  failed: number
  /** 整段耗时（首步开始 → 末步结束/now） */
  durationMs?: number
}

export function timelineSummary(steps: TimelineStep[], now = Date.now()): TimelineSummary {
  const items = steps.flatMap((s) => s.items)
  const first = steps.find((s) => s.startAt !== undefined)
  const lastEnd = [...steps].reverse().find((s) => s.endAt !== undefined)
  return {
    calls: items.length,
    steps: steps.length,
    parallelSteps: steps.filter((s) => s.parallel).length,
    running: items.filter((i) => i.status === 'start').length,
    failed: items.filter((i) => i.status === 'fail').length,
    durationMs:
      first?.startAt !== undefined
        ? Math.max(0, (lastEnd?.endAt ?? now) - first.startAt)
        : undefined
  }
}

/** 时长文案：<10s 带一位小数（0.8s / 3.4s），≥10s 取整（12s），≥60s 用 1m03s */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 10_000) return (ms / 1000).toFixed(1) + 's'
  if (ms < 60_000) return Math.round(ms / 1000) + 's'
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return m + 'm' + String(s).padStart(2, '0') + 's'
}

/** 一步的标题：单调用用工具名，多调用用「N 个调用并行」 */
export function stepTitle(step: TimelineStep): string {
  if (step.items.length === 1) return step.items[0].name
  return step.items.length + ' 个调用并行'
}

/**
 * 把相邻的工具行并成一段（历史消息里的 tool_call 是逐条存的，连着几条就是同一轮的工具流水）。
 * 输入只需 { id, isTool }：本模块不依赖消息领域类型，调用方自己决定怎么渲染。
 */
export function splitToolRuns<T extends { id: number | string; isTool: boolean }>(
  rows: T[]
): Array<{ tool: false; row: T } | { tool: true; rows: T[] }> {
  const out: Array<{ tool: false; row: T } | { tool: true; rows: T[] }> = []
  let buf: T[] = []
  const flush = (): void => {
    if (buf.length > 0) out.push({ tool: true, rows: buf })
    buf = []
  }
  for (const r of rows) {
    if (r.isTool) {
      buf.push(r)
      continue
    }
    flush()
    out.push({ tool: false, row: r })
  }
  flush()
  return out
}
