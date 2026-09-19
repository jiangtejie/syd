import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { generateText, stepCountIs, streamText, type ModelMessage } from 'ai'
import { readProviderConfig } from '../provider'
import { getConfig } from '../../../db/repos/config'
import {
  appendChatMessage,
  getChatById,
  lastUserMessage,
  listChatMessages,
  popLastChatMessage,
  renameChat,
  touchChat
} from '../../../db/repos/chatRepo'
import { buildWorkbenchSystem } from './context'
import { buildWorkbenchToolSet, type WbEvidenceRow } from './tools'
import { emitWorkbenchEvent } from './events'
import { describeModelError } from '../modelErrors'
import { budgetExhaustedMessage, looksBudgetExhausted, planOutputBudget } from '../outputBudget'
import { createLogger } from '../../logging'

const wbLog = createLogger('wb')

/**
 * 工作台引擎(AI SDK 原生工具循环;不自研 loop/协议/流式)。
 * - model = openai-compatible(沿用 ai.baseUrl/model/key 配置);
 * - tools = 产品原生能力(见 tools.ts):只读查询 + 唯一写工具 send_message(逐次审批);
 * - 会话复用 chat_session/chat_message;事件通道 ai:wb;AbortController 停止;
 * - 上下文预算:历史 ≤40 条 / ≤24k 字符 / 单条 6k,超限用 generateText 压缩旧段。
 */

const MAX_ROWS = 40
const MAX_CHARS = 24_000
const MAX_MSG_CHARS = 6000
const COMPRESS_THRESHOLD_ROWS = 24
const COMPRESS_THRESHOLD_CHARS = 36_000
/** 推理过程(思考内容)实时上屏上限:超限后不再推送/落库,避免消息体过大 */
const REASON_CAP = 6000
/** 工具调用参数/结果推送到渲染端的上限(渲染端可折叠查看,截断防刷屏) */
const TOOL_IO_CAP = 4000
/**
 * 主循环的输出预算默认值。
 * 思考型模型的思考过程也算在这个预算里（见 services/ai/outputBudget.ts）：
 * 预算不够时它会把整个额度用在思考上，一个字正文都不写 —— 所以预算不是"随便定个数"，
 * 而要按模型类型规划 + 失败后自动放大。
 */
const DEFAULT_OUTPUT_TOKENS = 2400

/** 工具参数/结果 → 可推送文本(≤TOOL_IO_CAP,带截断标记) */
function clipToolIO(v: unknown): { text: string; truncated: boolean } {
  let text: string
  if (v === null || v === undefined) {
    text = ''
  } else if (typeof v === 'string') {
    text = v.trim()
  } else {
    try {
      text = JSON.stringify(v, null, 2)
    } catch {
      text = String(v)
    }
  }
  if (text.length <= TOOL_IO_CAP) return { text, truncated: false }
  return { text: `${text.slice(0, TOOL_IO_CAP)}\n…(已截断,原 ${text.length} 字)`, truncated: true }
}

/** 剔除控制字符/零宽字符,避免干扰 markdown 解析与复制 */
function cleanModelText(s: string): string {
  /* eslint-disable no-control-regex -- 有意清理模型输出中的控制字符 */
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
  /* eslint-enable no-control-regex */
}

/** 段落引用编号 → 证据快照条目(仅解析本回合真实存在的行号;排除 markdown 链接 [n](url)) */
function citedItems(text: string, pool: WbEvidenceRow[]): WbEvidenceRow[] {
  const out: WbEvidenceRow[] = []
  const seen = new Set<number>()
  const re = /\[(\d{1,3})\](?!\()/g
  for (const m of text.matchAll(re)) {
    const n = Number(m[1])
    if (seen.has(n)) continue
    seen.add(n)
    const row = pool.find((p) => p.n === n)
    if (row) {
      out.push(row)
      if (out.length >= 12) break
    }
  }
  return out
}

/* 会话自动起标题:仅当仍为默认标题时,用首条有实质内容的回答做一次 ≤14 字总结(失败静默回退) */
const AUTO_TITLE_DEFAULTS = new Set(['工作台会话', '新对话', ''])

async function maybeAutoTitle(sessionId: number, model: WbModel, answer: string): Promise<void> {
  try {
    const s = getChatById(sessionId)
    if (!s) return
    const cur = (s.title ?? '').trim()
    if (!AUTO_TITLE_DEFAULTS.has(cur)) return
    if ((answer ?? '').trim().length < 16) return
    const res = await generateText({
      model,
      maxOutputTokens: 40,
      system:
        '你是会话标题生成器:用不超过 14 个汉字概括助手回答的主题(如「今日待跟进清单」「XX 客户咨询处理」)。只输出标题本身,不要引号、标点或解释。',
      prompt: `助手刚才的回答:\n${answer.slice(0, 500)}`
    })
    const title = (res.text ?? '')
      .trim()
      .replace(/["'“”‘’。.!！?\s]+$/g, '')
      .slice(0, 16)
    if (!title || title.includes('\n')) return
    renameChat(sessionId, title)
  } catch {
    /* 标题生成失败不影响会话 */
  }
}

interface RunHandle {
  controller: AbortController
  active: boolean
}

const running = new Map<number, RunHandle>()

/* ══════════ 本次运行可靠性统计(成功/失败/最近失败原因) ══════════ */

interface RelRecord {
  at: number
  ok: boolean
  err?: string
}

const relHistory: RelRecord[] = []
const REL_KEEP = 40

function recordRel(ok: boolean, err?: string): void {
  relHistory.push({ at: Date.now(), ok, err: err ? err.slice(0, 160) : undefined })
  if (relHistory.length > REL_KEEP) relHistory.splice(0, relHistory.length - REL_KEEP)
}

export function getWorkbenchReliability(): {
  total: number
  ok: number
  fail: number
  rate: number | null
  lastFailures: Array<{ at: number; err: string }>
} {
  const total = relHistory.length
  const ok = relHistory.filter((r) => r.ok).length
  const fail = total - ok
  return {
    total,
    ok,
    fail,
    rate: total > 0 ? Math.round((ok / total) * 1000) / 10 : null,
    lastFailures: relHistory
      .filter((r) => !r.ok)
      .slice(-5)
      .reverse()
      .map((r) => ({ at: r.at, err: r.err ?? '未知错误' }))
  }
}

export interface WbSendResult {
  ok: boolean
  error?: string
}

type WbModel = ReturnType<ReturnType<typeof createOpenAICompatible>['chatModel']>

function reasonerModel(model: string): boolean {
  return /(reasoner|deepseek-r1|r1-|o1|o3|think|thinking)/i.test(model)
}

/** 历史 → SDK messages(仅 user/assistant 文本;工具行由 SDK 自动重建) */
function historyToMessages(
  rows: Array<{ role: string; kind: string; content: string }>
): ModelMessage[] {
  const turns: ModelMessage[] = []
  for (const r of rows) {
    if (
      r.kind === 'tool_call' ||
      r.kind === 'tool_result' ||
      r.kind === 'compact' ||
      r.kind === 'error'
    )
      continue
    if (r.role === 'user') {
      turns.push({ role: 'user', content: r.content } as ModelMessage)
    } else if (r.role === 'assistant') {
      turns.push({ role: 'assistant', content: r.content } as ModelMessage)
    }
  }
  const kept: ModelMessage[] = []
  let sum = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]
    const text = typeof t.content === 'string' ? t.content : ''
    const content =
      text.length > MAX_MSG_CHARS ? `${text.slice(0, MAX_MSG_CHARS)}\n…(超长已截断)` : text
    if (kept.length > 0 && sum + content.length > MAX_CHARS) break
    kept.unshift({ role: t.role, content } as ModelMessage)
    sum += content.length
  }
  return kept.slice(-MAX_ROWS)
}

/** 长会话压缩旧段(失败降级丢弃旧段,不阻塞会话) */
async function compressHistory(
  model: WbModel,
  rows: Array<{ role: string; kind: string; content: string }>
): Promise<string | null> {
  const keep = Math.ceil(rows.length / 2)
  const old = rows.slice(0, rows.length - keep)
  const text = old
    .map((r) => `${r.role === 'user' ? '用户' : '助手'}: ${r.content.slice(0, 400)}`)
    .join('\n')
    .slice(-24_000)
  try {
    const res = await generateText({
      model,
      maxOutputTokens: 600,
      system:
        '你是对话摘要器。把客服工作台历史对话压缩为不超过 400 字的中文摘要:保留已查到的业务结论与数据要点、客户诉求与状态、待办。不要复述寒暄。',
      prompt: `历史对话:\n${text}`
    })
    return res.text.trim().slice(0, 1400) || null
  } catch {
    return null
  }
}

/** 发送一条工作台消息;wxid 为会话绑定的微信账号(未绑定传空串);images=本轮附图(data URL) */
export async function sendWorkbenchMessage(
  sessionId: number,
  wxid: string,
  text: string,
  opts: { images?: string[] } = {}
): Promise<WbSendResult> {
  const msg = (text || '').trim()
  if (!msg) return { ok: false, error: '消息为空' }

  /** 校验并解析本轮附图(data:image/xxx;base64,…),仅保留合规项 */
  const images: Array<{ mediaType: string; base64: string }> = []
  const rawImages = Array.isArray(opts.images) ? opts.images.slice(0, 3) : []
  let totalLen = 0
  for (const raw of rawImages) {
    if (typeof raw !== 'string' || raw.length > 2_600_000) continue
    const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(raw)
    if (!m) continue
    totalLen += raw.length
    if (totalLen > 5_200_000) break
    images.push({ mediaType: m[1], base64: m[2] })
  }
  if (running.get(sessionId)?.active) {
    return { ok: false, error: '正在处理中,请等待或先停止' }
  }
  const cfg = readProviderConfig()
  if (!cfg.enabled || !cfg.apiKey || !cfg.model) {
    const err = 'AI 通道未配置或未启用:请到 设置 → AI 助手 配置模型后再试。'
    appendChatMessage(sessionId, 'assistant', 'error', err)
    emitWorkbenchEvent(sessionId, { type: 'error', text: err })
    return { ok: false, error: err }
  }
  if (reasonerModel(cfg.model) && getConfig('wb.allowReasoner') !== '1') {
    const err =
      '当前模型疑似思考型(工具调用支持不稳定)。请到 设置 → AI 助手 换用非思考模型,或设置 wb.allowReasoner=1 强制尝试。'
    appendChatMessage(sessionId, 'assistant', 'error', err)
    emitWorkbenchEvent(sessionId, { type: 'error', text: err })
    return { ok: false, error: err }
  }

  const provider = createOpenAICompatible({
    name: 'wechat-cs-workbench',
    apiKey: cfg.apiKey,
    baseURL: cfg.baseUrl
  })
  const model = provider.chatModel(cfg.model)
  const boundWxid = (wxid || '').trim()

  appendChatMessage(sessionId, 'user', 'text', msg)
  const handle: RunHandle = { controller: new AbortController(), active: true }
  running.set(sessionId, handle)
  const signal = handle.controller.signal
  wbLog.info(
    `[会话${sessionId}] 开始生成 q=${msg.slice(0, 120)}${
      boundWxid ? ` wxid=${boundWxid}` : ''
    }${images.length > 0 ? ` 附图${images.length}` : ''}`
  )

  try {
    // 工具痕迹/压缩标记行仅用于展示,不进入模型上下文与压缩统计
    const allRows = listChatMessages(sessionId)
    let rows = allRows
      .filter((r) => r.kind !== 'tool_call' && r.kind !== 'tool_result' && r.kind !== 'compact')
      .map((r) => ({ role: r.role, kind: r.kind, content: r.content }))
    let summary: string | null = null
    const chars = rows.reduce((n, r) => n + r.content.length, 0)
    if (rows.length >= COMPRESS_THRESHOLD_ROWS && chars > COMPRESS_THRESHOLD_CHARS) {
      summary = await compressHistory(model, rows)
      rows = rows.slice(rows.length - Math.ceil(rows.length / 2))
      // 压缩是「历史透明变更」:先于生成推送给渲染端,界面在消息流顶部展示可展开标记;
      // 并落一条 compact 展示行,持久可回看(刷新/重开仍在,重试时随尾部一并清理)
      const compactText = summary ?? '旧对话过长已压缩,仅保留最近一段(摘要生成失败)。'
      appendChatMessage(sessionId, 'assistant', 'compact', compactText)
      emitWorkbenchEvent(sessionId, { type: 'compaction', text: compactText })
      wbLog.info(`[会话${sessionId}] 上下文已压缩(rows=${allRows.length})`)
    }
    const messages: ModelMessage[] = historyToMessages(rows)

    // 附图:把本轮用户消息(末尾 user 行)替换为多模态 parts(图片仅本轮生效,不入库回看)
    if (images.length > 0) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]
        if (m.role === 'user' && typeof m.content === 'string') {
          messages[i] = {
            role: 'user',
            content: [
              { type: 'text' as const, text: m.content },
              ...images.map((img) => ({
                type: 'file' as const,
                mediaType: img.mediaType,
                data: img.base64
              }))
            ]
          } as ModelMessage
          break
        }
      }
    }

    // 上下文占用估算(字符口径,供界面进度提示):压缩后为保留段占比
    const usedChars = messages.reduce((n, m) => {
      const c = typeof m.content === 'string' ? m.content : ''
      return n + c.length
    }, 0)
    emitWorkbenchEvent(sessionId, {
      type: 'context',
      usedChars,
      capChars: MAX_CHARS
    })
    const system = buildWorkbenchSystem(boundWxid, { summary })
    /** 本回合行级证据池:编号与模型看到的 [n] 前缀一致,供回答引用解析 */
    const evPool: WbEvidenceRow[] = []
    const toolSet = buildWorkbenchToolSet(boundWxid, sessionId, {
      onEvidenceRow: (row) => {
        if (evPool.length < 200) evPool.push(row)
      },
      // 与营销工作台同一套：点「停止」时工具层也立刻收手，而不是等它自己跑完
      signal
    })

    // 本轮时间线日志:正文按工具边界分段,工具痕迹带参数/结果;
    // 只在整轮成功时落库(失败/中止不写半截痕迹)
    interface TurnLogEntry {
      kind: 'text' | 'tool'
      text?: string
      name?: string
      args?: string
      output?: string
      status?: 'pending' | 'done' | 'fail'
    }
    const turnLog: TurnLogEntry[] = []
    let seg = ''
    const flushSeg = (): void => {
      const s = seg.trim()
      seg = ''
      if (s) turnLog.push({ kind: 'text', text: s })
    }
    const reasonMeta = (): Record<string, unknown> | null => {
      const r = reasoning.trim()
      if (!r) return null
      const m: Record<string, unknown> = { reasoning: r }
      if (reasonStartedAt > 0) {
        m.reasoningMs = Math.max(0, (reasonEndedAt || Date.now()) - reasonStartedAt)
      }
      return m
    }
    const pushTool = (name: string, args?: string): void => {
      flushSeg()
      turnLog.push({ kind: 'tool', name, args, status: 'pending' })
    }
    const finishTool = (name: string, output: string, status: 'done' | 'fail'): void => {
      for (let i = turnLog.length - 1; i >= 0; i--) {
        const e = turnLog[i]
        if (e.kind === 'tool' && e.name === name && e.status === 'pending') {
          e.output = output
          e.status = status
          return
        }
      }
    }

    emitWorkbenchEvent(sessionId, { type: 'status', text: '生成中' })
    let content = ''
    let reasoning = ''
    let reasonStartedAt = 0
    let reasonEndedAt = 0
    let usageIn = 0
    let usageOut = 0
    /** 接口自报的思考 tokens 与结束原因：判断"预算是否被思考吃光"要看它们 */
    let usageReasoning = 0
    let finishReason = ''

    /** 单次流式请求(读/重试均走这里;失败/中止抛错由外层判断) */
    const runStream = async (maxTokens: number): Promise<void> => {
      const result = streamText({
        model,
        system,
        messages,
        tools: toolSet,
        maxOutputTokens: maxTokens,
        temperature: cfg.temperature,
        abortSignal: signal,
        stopWhen: stepCountIs(10)
      })

      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          content += part.text
          seg += part.text
          emitWorkbenchEvent(sessionId, { type: 'delta', token: part.text })
        } else if (part.type === 'reasoning-delta') {
          // 思考型模型(reasoner)的推理过程:实时推送,收尾随 meta.reasoning 落库
          const t = cleanModelText((part as { text?: string }).text ?? '')
          if (t) {
            const now = Date.now()
            if (reasonStartedAt === 0) reasonStartedAt = now
            reasonEndedAt = now
            const room = REASON_CAP - reasoning.length
            if (room > 0) {
              const chunk = room >= t.length ? t : t.slice(0, room)
              reasoning += chunk
              emitWorkbenchEvent(sessionId, { type: 'reasoning', token: chunk })
            }
          }
        } else if (part.type === 'tool-call') {
          const io = clipToolIO((part as { input?: unknown }).input)
          pushTool(part.toolName, io.text)
          emitWorkbenchEvent(sessionId, {
            type: 'tool',
            tool: part.toolName,
            toolStatus: 'start',
            args: io.text
          })
        } else if (part.type === 'tool-result') {
          const io = clipToolIO((part as { output?: unknown }).output)
          finishTool(part.toolName, io.text, 'done')
          emitWorkbenchEvent(sessionId, {
            type: 'tool',
            tool: part.toolName,
            toolStatus: 'done',
            output: io.text,
            outTrunc: io.truncated
          })
        } else if (part.type === 'tool-error') {
          const msg =
            part.error instanceof Error ? part.error.message : String(part.error ?? '').trim()
          finishTool(part.toolName, msg.slice(0, TOOL_IO_CAP) || '工具执行失败(无详情)', 'fail')
          emitWorkbenchEvent(sessionId, {
            type: 'tool',
            tool: part.toolName,
            toolStatus: 'fail',
            output: msg.slice(0, TOOL_IO_CAP) || '工具执行失败(无详情)',
            outTrunc: msg.length > TOOL_IO_CAP
          })
        } else if (part.type === 'error') {
          throw part.error
        } else if (part.type === 'finish') {
          usageIn = part.totalUsage?.inputTokens ?? 0
          usageOut = part.totalUsage?.outputTokens ?? 0
          usageReasoning = part.totalUsage?.outputTokenDetails?.reasoningTokens ?? 0
          finishReason = String(part.finishReason ?? '')
        }
      }
    }

    // 预算规划：设置里显式配了听用户的；没配时用默认值，思考型模型第一轮就抬到下限
    const budget = planOutputBudget({
      configured: getConfig('ai.maxOutputTokens'),
      fallback: DEFAULT_OUTPUT_TOKENS,
      model: cfg.model
    })
    let usedBudget = budget.maxTokens

    // 瞬时失败自动重试:仅当首轮「零产出」(无正文/推理/工具)时,退避 700ms 重试一次;
    // 已有部分产出或已执行工具不重试,避免重复副作用与重复审批
    for (let attempt = 0; ; attempt++) {
      try {
        await runStream(usedBudget)
        break
      } catch (e) {
        const aborted = signal.aborted || (e instanceof Error && e.name === 'AbortError')
        if (aborted) throw e
        if (attempt > 0 || content !== '' || reasoning !== '' || turnLog.length > 0) throw e
        await new Promise((r) => setTimeout(r, 700))
      }
    }

    // 预算被思考吃光：整轮放大预算重试一次。
    // 只在「没有正文 + 没有跑过工具」时重试：跑过工具再重试会重复副作用与重复审批。
    if (
      !signal.aborted &&
      turnLog.every((e) => e.kind !== 'tool') &&
      looksBudgetExhausted({
        hasText: content.trim() !== '',
        reasoningChars: reasoning.length,
        reasoningTokens: usageReasoning,
        finishReason
      })
    ) {
      const bigger = planOutputBudget({
        configured: getConfig('ai.maxOutputTokens'),
        fallback: DEFAULT_OUTPUT_TOKENS,
        model: cfg.model,
        attempt: 1
      })
      wbLog.warn(
        `[会话${sessionId}] 输出预算被思考吃光(输出 ${usageOut} tokens / 思考 ${usageReasoning}),放大到 ${bigger.maxTokens} 重试`
      )
      emitWorkbenchEvent(sessionId, {
        type: 'status',
        text: `思考过长已耗尽输出预算，放大到 ${bigger.maxTokens} 重试…`
      })
      try {
        await runStream(bigger.maxTokens)
        usedBudget = bigger.maxTokens
      } catch (e) {
        const aborted = signal.aborted || (e instanceof Error && e.name === 'AbortError')
        if (aborted) throw e
        // 放大后仍然失败：保留下面的诊断（至少能说清是预算问题）
        wbLog.warn(
          `[会话${sessionId}] 放大预算后仍失败: ${e instanceof Error ? e.message : String(e)}`
        )
      }
    }

    // 落库前收尾:把最后一个文本段计入时间线日志
    flushSeg()

    if (signal.aborted) {
      wbLog.info(`[会话${sessionId}] 已停止(用户中止,落库前)`)
      emitWorkbenchEvent(sessionId, { type: 'status', text: '已停止' })
      return { ok: true }
    }
    const trimmed = cleanModelText(content).trim()
    if (!trimmed) {
      // 说清到底是"预算被思考吃光"还是"通道/结构异常"：前者用户能自己解决（调预算/换模型）
      const exhausted = looksBudgetExhausted({
        hasText: false,
        reasoningChars: reasoning.length,
        reasoningTokens: usageReasoning,
        finishReason
      })
      const err = exhausted
        ? budgetExhaustedMessage({
            maxTokens: usedBudget,
            outputTokens: usageOut,
            reasoningTokens: usageReasoning,
            reasoningChars: reasoning.length
          })
        : '模型未返回内容(通道或响应结构异常),可重试。'
      appendChatMessage(sessionId, 'assistant', 'error', err)
      emitWorkbenchEvent(sessionId, { type: 'error', text: err })
      return { ok: true }
    }
    const hasTool = turnLog.some((e) => e.kind === 'tool')
    const tokensMeta: Record<string, unknown> = {}
    if (usageIn || usageOut) tokensMeta.tokens = { input: usageIn, output: usageOut }
    const reason = reasonMeta()

    let messageId: number
    if (!hasTool) {
      // 无工具:保持单条文本(现状),meta 附加 tokens/推理过程
      const meta: Record<string, unknown> = { ...tokensMeta }
      if (reason) Object.assign(meta, reason)
      messageId = appendChatMessage(sessionId, 'assistant', 'text', trimmed, meta)
    } else {
      // 有工具:按发生顺序把时间线落库(文本分段 + 工具痕迹行),历史/刷新均可回看;
      // 推理过程挂首段文本,用量挂末段文本
      let reasonPlaced = false
      let lastId = 0
      turnLog.forEach((e, i) => {
        const isLast = i === turnLog.length - 1
        if (e.kind === 'text') {
          const meta: Record<string, unknown> = {}
          if (reason && !reasonPlaced) {
            Object.assign(meta, reason)
            reasonPlaced = true
          }
          if (isLast) Object.assign(meta, tokensMeta)
          // 证据溯源:该段落引用的工具行快照(编号 → 原文行),随消息落库可回看
          const ev = citedItems(e.text ?? '', evPool)
          if (ev.length > 0) meta.evidence = ev
          lastId = appendChatMessage(sessionId, 'assistant', 'text', e.text ?? '', meta)
        } else {
          appendChatMessage(sessionId, 'assistant', 'tool_call', '', {
            name: e.name ?? '',
            args: e.args ?? '',
            output: e.output ?? '',
            status: e.status === 'fail' ? 'fail' : 'done'
          })
        }
      })
      messageId = lastId
    }
    touchChat(sessionId)
    emitWorkbenchEvent(sessionId, { type: 'done', messageId })
    recordRel(true)
    wbLog.info(
      `[会话${sessionId}] 完成 msgId=${messageId} tools=${hasTool ? 'yes' : 'no'} tokens=${usageIn}/${usageOut}`
    )
    // 默认标题会话:首轮回答落库后后台总结标题(不阻塞回复与事件)
    void maybeAutoTitle(sessionId, model, trimmed)
    return { ok: true }
  } catch (e) {
    const aborted = signal.aborted || (e instanceof Error && e.name === 'AbortError')
    if (aborted) {
      wbLog.info(`[会话${sessionId}] 已停止(用户中止)`)
      emitWorkbenchEvent(sessionId, { type: 'status', text: '已停止' })
      return { ok: true }
    }
    const rawErr = e instanceof Error ? e.message : String(e)
    const errMsg = describeModelError(e) || rawErr
    wbLog.error(`[会话${sessionId}] 生成失败: ${errMsg}`, e)
    recordRel(false, errMsg)
    appendChatMessage(sessionId, 'assistant', 'error', errMsg)
    emitWorkbenchEvent(sessionId, { type: 'error', text: errMsg })
    return { ok: true }
  } finally {
    handle.active = false
    running.delete(sessionId)
  }
}

export function stopWorkbenchChat(sessionId: number): void {
  running.get(sessionId)?.controller.abort()
}

/** 重试:清除尾部 assistant 行后重发最后一条用户消息 */
export async function retryWorkbenchMessage(
  sessionId: number,
  wxid: string
): Promise<WbSendResult> {
  if (running.get(sessionId)?.active) return { ok: false, error: '正在处理中' }
  const rows = listChatMessages(sessionId)
  while (rows.length > 0) {
    const last = rows[rows.length - 1]
    if (last.role === 'assistant') {
      popLastChatMessage(sessionId)
      rows.pop()
      continue
    }
    break
  }
  const text = lastUserMessage(sessionId)
  if (!text) return { ok: false, error: '没有可重试的消息' }
  return await sendWorkbenchMessage(sessionId, wxid, text)
}

/**
 * 编辑后重发:清除尾部 assistant 行与最后一条用户行,以新文本重发。
 * 语义:改写最近一轮提问(仅限最后一条用户消息,UI 端也做了同款限制)。
 */
export async function resendWorkbenchMessage(
  sessionId: number,
  wxid: string,
  text: string
): Promise<WbSendResult> {
  if (running.get(sessionId)?.active) return { ok: false, error: '正在处理中' }
  const newText = (text || '').trim()
  if (!newText) return { ok: false, error: '消息为空' }
  const rows = listChatMessages(sessionId)
  while (rows.length > 0) {
    const last = rows[rows.length - 1]
    if (last.role === 'assistant') {
      popLastChatMessage(sessionId)
      rows.pop()
      continue
    }
    break
  }
  const tail = rows[rows.length - 1]
  if (!tail || tail.role !== 'user') return { ok: false, error: '没有可改写的问题' }
  popLastChatMessage(sessionId)
  return await sendWorkbenchMessage(sessionId, wxid, newText)
}
