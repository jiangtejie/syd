import { getConfig } from '../../db/repos/config'
import { openSecret } from '../secrets'
import type { ChatTurn } from '../../../shared/types'
import { insertAiRun } from '../../db/repos/aiRunRepo'
import { createLimiter } from './limit'
import {
  aiHttpError,
  backoffMs,
  classifyError,
  errorCodeOf,
  isRetryableError,
  MAX_ATTEMPTS,
  retryAfterOf,
  retryAfterSecOf
} from './retryPolicy'
import { budgetExhaustedMessage, planOutputBudget } from './outputBudget'
import { createLogger } from '../logging'

const providerLog = createLogger('ai-provider')

/**
 * LLM Provider 抽象（T7，方案 §4.4 AI 生成层）。
 * 支持任意 OpenAI 兼容接口（/chat/completions），配置存 app_config：
 *   ai.baseUrl  ai.apiKey  ai.model  ai.enabled
 * ai.apiKey 落库为 safeStorage 密文（enc1: 前缀），读取时在此统一解密；明文形态兼容。
 */

/** token 用量(流式解析,供应商不返回时为 undefined) */
export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
}

/** 一次流式调用的统一结果 */
export interface StreamOnceResult {
  text: string
  toolCalls: Array<{ id?: string; name: string; arguments: string }>
  usage?: TokenUsage
  reasoningText?: string
}

/** 原生工具 schema(OpenAI function calling) */
export interface ToolSchema {
  name: string
  description?: string
  parameters: unknown
}

/** 发送给模型的消息(含原生工具轮:assistant tool_calls / tool 角色) */
export type WireMsg =
  | ChatTurn
  | {
      role: 'assistant'
      content?: string | null
      tool_calls?: Array<{
        id: string
        type: 'function'
        function: { name: string; arguments: string }
      }>
    }
  | { role: 'tool'; tool_call_id: string; content: string }

export interface AiProvider {
  /** 系统 + 用户消息，返回模型输出文本（signal 可中断：用户点停止时子调用也要立刻收手） */
  complete(
    system: string,
    user: string,
    opts?: { maxTokens?: number; signal?: AbortSignal }
  ): Promise<string>
  /** 多轮流式对话（AI 助手用）：SSE 逐 token 回调，signal 可中断 */
  streamChat(
    messages: ChatTurn[],
    opts?: {
      maxTokens?: number
      signal?: AbortSignal
      onDelta?: (token: string) => void
      onReasoning?: (token: string) => void
    }
  ): Promise<{ usage?: TokenUsage; reasoningText?: string }>
  /** 原生 function-calling 流式:tools 透传;工具参数分片自动聚合;signal 可中断 */
  streamChatTools(
    messages: WireMsg[],
    tools: ToolSchema[],
    opts?: {
      maxTokens?: number
      signal?: AbortSignal
      onText?: (chunk: string) => void
      onReasoning?: (token: string) => void
    }
  ): Promise<{
    text: string
    toolCalls: Array<{ id?: string; name: string; arguments: string }>
    usage?: TokenUsage
    reasoningText?: string
  }>
  readonly name: string
}

export interface ProviderConfig {
  baseUrl: string
  apiKey: string
  model: string
  enabled: boolean
  /** 采样温度(0~1.5,默认 0.7);部分推理模型不支持温度参数,由请求层自动去掉 */
  temperature: number
}

export function readProviderConfig(): ProviderConfig {
  const baseUrl = (getConfig('ai.baseUrl') || 'https://api.openai.com/v1').replace(/\/+$/, '')
  const apiKey = openSecret(getConfig('ai.apiKey'))
  const model = getConfig('ai.model')?.trim() || ''
  const enabled = getConfig('ai.enabled') === '1' || getConfig('ai.enabled') === 'true'
  const rawTemp = Number(getConfig('ai.temperature'))
  const temperature = Number.isFinite(rawTemp) && rawTemp >= 0 && rawTemp <= 1.5 ? rawTemp : 0.7
  return { baseUrl, apiKey, model, enabled, temperature }
}

/**
 * 全局并发闸门。为什么要它：群问题提取、数字员工值班、AI 工作台、营销爆改可以同时打上去，
 * 以前没有任何并发控制 —— 撞上限流就是一批一起失败。4 是保守值：够用，且不会把上游打爆。
 */
const aiLimiter = createLimiter(4)

/** 单次请求（非流式，含连接与响应体）总时限 */
const JSON_TIMEOUT_MS = 60_000
/** 流式请求的硬上限（兜住「永远不会结束」的流；正常情况下靠下面的空闲超时先触发） */
const STREAM_DEADLINE_MS = 300_000
/**
 * 流式**空闲**超时：多久没收到任何分片就判定挂死。
 * 这才是「流挂死」的正确判据 —— 固定总时限会误杀长回答（思考型模型尤其慢）。
 */
const STREAM_IDLE_MS = 45_000

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * 读一帧，带**空闲超时**：多久没数据就判定流挂死并中断。
 *
 * 为什么不用固定总时限：长回答（尤其思考型模型）本来就要跑几分钟，一刀切会误杀正常请求；
 * 而「TCP 半开 / 上游不结束流」的特征是**再也没有数据**，空闲超时正好命中。
 * 以前没有它，挂死的会话会一直占着 running，等于那个客户/那个群从此不再被回复。
 */
async function readWithIdle(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number,
  signal: AbortSignal
): Promise<{ done: boolean; value?: Uint8Array }> {
  let timer: NodeJS.Timeout | null = null
  let onAbort: (() => void) | null = null
  try {
    return await Promise.race([
      reader.read() as Promise<{ done: boolean; value?: Uint8Array }>,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`LLM 流式响应空闲超过 ${Math.round(idleMs / 1000)}s，判定挂死`)),
          idleMs
        )
      }),
      new Promise<never>((_, reject) => {
        if (signal.aborted) {
          reject(new Error('用户已取消'))
          return
        }
        onAbort = () => reject(new Error('用户已取消'))
        signal.addEventListener('abort', onAbort, { once: true })
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

class OpenAiCompatProvider implements AiProvider {
  readonly name = 'openai-compat'
  constructor(
    private cfg: ProviderConfig,
    /** 调用方标签（如 suggest / issue-extract / duty）：只用于 ai_run 计量与排障 */
    private moduleName = 'ai'
  ) {}

  /**
   * 带并发闸门、超时、退避重试与计量的请求执行器。
   *
   * 重试只针对**可重试**的错误：限流(429)、网关/服务端 5xx、网络类错误、超时中断；
   * **用户主动取消绝不重试**（那是人的意图，重试会让「点了停止又发出去」变成真的）。
   * 每次尝试都落一行 ai_run —— 重试也是真花钱的调用，账要算清楚。
   */
  private async withGate<T>(
    label: string,
    deadlineMs: number,
    userSignal: AbortSignal | undefined,
    run: (signal: AbortSignal, meter: { tokensIn?: number; tokensOut?: number }) => Promise<T>
  ): Promise<T> {
    return aiLimiter.run(async () => {
      const started = Date.now()
      let lastErr: unknown = null
      const meter: { tokensIn?: number; tokensOut?: number } = {}
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(new Error('AI 请求超时')), deadlineMs)
        // 用户取消要能立刻打断本次尝试：把两个 signal 串起来
        const onAbort = (): void => ctrl.abort(new Error('用户已取消'))
        if (userSignal) {
          if (userSignal.aborted) onAbort()
          else userSignal.addEventListener('abort', onAbort, { once: true })
        }
        try {
          const out = await run(ctrl.signal, meter)
          insertAiRun({
            module: this.moduleName,
            model: this.cfg.model,
            ok: true,
            latencyMs: Date.now() - started,
            attempts: attempt,
            tokensIn: meter.tokensIn,
            tokensOut: meter.tokensOut
          })
          return out
        } catch (e) {
          lastErr = e
          const abortedByUser = !!userSignal?.aborted
          const retryable = !abortedByUser && isRetryableError(e)
          const last = attempt >= MAX_ATTEMPTS
          if (!retryable || last) break
          const wait = backoffMs(attempt, retryAfterOf(e))
          providerLog.warn(
            `${label}: 第 ${attempt} 次失败（${classifyError(e)}），${wait}ms 后重试 — ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`
          )
          await sleep(wait)
        } finally {
          clearTimeout(timer)
          if (userSignal) userSignal.removeEventListener('abort', onAbort)
        }
      }
      const kind = classifyError(lastErr)
      insertAiRun({
        module: this.moduleName,
        model: this.cfg.model,
        ok: false,
        errorKind: kind,
        errorCode: errorCodeOf(lastErr),
        latencyMs: Date.now() - started,
        attempts: MAX_ATTEMPTS,
        tokensIn: meter.tokensIn,
        tokensOut: meter.tokensOut
      })
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? 'AI 调用失败'))
    })
  }

  async complete(
    system: string,
    user: string,
    opts?: { maxTokens?: number; signal?: AbortSignal }
  ): Promise<string> {
    const model = this.cfg.model
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
    // 思考型模型的 reasoning 会占用输出预算：预算统一走 services/ai/outputBudget.ts
    // （设置里的 ai.maxOutputTokens > 模块默认；思考型模型第一轮就抬到下限），
    // 截断且正文为空时按 4 倍放大重试一档。
    const planBase = (): number =>
      planOutputBudget({
        configured: getConfig('ai.maxOutputTokens'),
        fallback: opts?.maxTokens ?? 600,
        model
      }).maxTokens
    let maxTokens = planBase()

    // 整段（请求 + 解析 + 放大重试）都在闸门内：重试是**整次调用**重来，
    // 不会出现「重试了但只重试了半截」的状态。
    // 把外部（用户点停止）的 signal 也接进闸门：一次 complete 可能跑几十秒，
    // 不接的话停止按钮对这种子调用完全无效
    return await this.withGate('complete', JSON_TIMEOUT_MS, opts?.signal, async (signal, meter) => {
      const post = (withTemp: boolean): Promise<Response> =>
        fetch(`${this.cfg.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.cfg.apiKey}`
          },
          body: JSON.stringify({
            model,
            messages,
            ...(withTemp ? { temperature: this.cfg.temperature } : {}),
            max_tokens: maxTokens
          }),
          signal
        })

      // 首次带 temperature 请求；推理模型 400 拒绝该参数时去掉后重试
      let res = await post(true)
      if (res.status === 400) {
        const errText = await res.text()
        if (
          /temperature/i.test(errText) &&
          /not support|unsupported|unexpected|invalid|不支持|不允许/i.test(errText)
        ) {
          res = await post(false)
        } else {
          throw aiHttpError(res.status, errText)
        }
      }
      if (!res.ok) {
        throw aiHttpError(res.status, await res.text(), retryAfterSecOf(res.headers))
      }

      // 最多两轮：解析正文；截断且正文为空 → 放大预算重试一次（同一信号，不再重复计量）
      for (let round = 0; ; round++) {
        const data = (await res.json()) as {
          choices?: Array<{
            message?: { content?: string | null; reasoning_content?: string | null }
            finish_reason?: string
          }>
          usage?: { prompt_tokens?: number; completion_tokens?: number }
        }
        if (data.usage) {
          meter.tokensIn = (meter.tokensIn ?? 0) + Number(data.usage.prompt_tokens ?? 0)
          meter.tokensOut = (meter.tokensOut ?? 0) + Number(data.usage.completion_tokens ?? 0)
        }
        const content = data.choices?.[0]?.message?.content?.trim()
        if (content) return content
        const msg = data.choices?.[0]?.message
        const reasoning = msg?.reasoning_content
        const finishedByLength = data.choices?.[0]?.finish_reason === 'length'
        if (finishedByLength && round === 0) {
          const bigger = planOutputBudget({
            configured: getConfig('ai.maxOutputTokens'),
            fallback: opts?.maxTokens ?? 600,
            model,
            attempt: 1
          }).maxTokens
          if (bigger > maxTokens) {
            maxTokens = bigger
            res = await post(false) // 思考型模型通常不接受 temperature，放大预算后不带该参数
            if (!res.ok) {
              throw aiHttpError(res.status, await res.text(), retryAfterSecOf(res.headers))
            }
            continue
          }
        }
        // 放大重试仍空 → 给出可诊断信息（带真实数字与下一步），而不是一句"返回为空"
        throw new Error(
          reasoning || finishedByLength
            ? budgetExhaustedMessage({
                maxTokens,
                outputTokens: meter.tokensOut ?? 0,
                reasoningChars: (reasoning ?? '').length
              })
            : 'LLM 返回为空（响应结构异常或无内容）'
        )
      }
    })
  }

  /** 统一 SSE 流式底层:支持原生 tools(tool_calls 分片聚合)、usage 与 reasoning 收集 */
  private async streamOnce(
    messages: WireMsg[],
    opts: {
      tools?: ToolSchema[]
      maxTokens?: number
      signal?: AbortSignal
      onText?: (chunk: string) => void
      onReasoning?: (token: string) => void
    }
  ): Promise<StreamOnceResult> {
    const model = this.cfg.model
    const maxTokens = opts.maxTokens ?? 2000
    const tools =
      opts.tools && opts.tools.length > 0
        ? opts.tools.map((t) => ({
            type: 'function' as const,
            function: {
              name: t.name,
              description: t.description ?? '',
              parameters: t.parameters
            }
          }))
        : undefined

    return await this.withGate('stream', STREAM_DEADLINE_MS, opts.signal, async (signal, meter) => {
      const post = (withTemp: boolean): Promise<Response> =>
        fetch(`${this.cfg.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.cfg.apiKey}`
          },
          body: JSON.stringify({
            model,
            messages,
            stream: true,
            ...(tools ? { tools } : {}),
            ...(withTemp ? { temperature: this.cfg.temperature } : {}),
            max_tokens: maxTokens
          }),
          signal
        })

      let res = await post(true)
      if (res.status === 400) {
        const errText = await res.text()
        if (
          /temperature/i.test(errText) &&
          /not support|unsupported|unexpected|invalid|不支持|不允许/i.test(errText)
        ) {
          res = await post(false)
        } else {
          throw aiHttpError(res.status, errText)
        }
      }
      if (!res.ok) {
        throw aiHttpError(res.status, await res.text(), retryAfterSecOf(res.headers))
      }
      if (!res.body) throw new Error('LLM 流式响应无 body')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let content = ''
      let reasoningText = ''
      let usage: TokenUsage | undefined
      const tcByIndex = new Map<number, { id: string; name: string; args: string }>()
      try {
        for (;;) {
          const { done, value } = await readWithIdle(reader, STREAM_IDLE_MS, signal)
          if (done) break
          buf += decoder.decode(value, { stream: true })
          for (;;) {
            const cut = buf.indexOf('\n\n')
            if (cut < 0) break
            const chunk = buf.slice(0, cut)
            buf = buf.slice(cut + 2)
            for (const line of chunk.split('\n')) {
              const s = line.trim()
              if (!s.startsWith('data:')) continue
              const data = s.slice(5).trim()
              if (data === '[DONE]') {
                break
              }
              try {
                const json = JSON.parse(data) as {
                  choices?: Array<{
                    delta?: {
                      content?: string | null
                      reasoning_content?: string | null
                      tool_calls?: Array<{
                        index?: number
                        id?: string
                        type?: string
                        function?: { name?: string; arguments?: string }
                      }>
                    }
                  }>
                  usage?: { prompt_tokens?: number; completion_tokens?: number }
                }
                const delta = json.choices?.[0]?.delta
                if (delta?.content) {
                  content += delta.content
                  opts.onText?.(delta.content)
                }
                if (delta?.reasoning_content) {
                  reasoningText += delta.reasoning_content
                  opts.onReasoning?.(delta.reasoning_content)
                }
                if (Array.isArray(delta?.tool_calls)) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0
                    const cur = tcByIndex.get(idx) ?? { id: '', name: '', args: '' }
                    if (tc.id) cur.id = tc.id
                    if (tc.function?.name) cur.name += tc.function.name
                    if (tc.function?.arguments) cur.args += tc.function.arguments
                    tcByIndex.set(idx, cur)
                  }
                }
                if (json.usage && (json.usage.prompt_tokens || json.usage.completion_tokens)) {
                  usage = {
                    inputTokens: json.usage.prompt_tokens,
                    outputTokens: json.usage.completion_tokens
                  }
                }
              } catch {
                /* 忽略无法解析的分片 */
              }
            }
          }
        }
      } finally {
        reader.releaseLock()
      }
      const toolCalls = [...tcByIndex.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => ({ id: v.id || undefined, name: v.name, arguments: v.args }))
      meter.tokensIn = usage?.inputTokens
      meter.tokensOut = usage?.outputTokens
      return {
        text: content,
        toolCalls,
        usage,
        reasoningText: reasoningText.slice(-2000)
      }
    })
  }

  /** 文本对话流式(无原生工具) */
  async streamChat(
    messages: ChatTurn[],
    opts: {
      maxTokens?: number
      signal?: AbortSignal
      onDelta?: (token: string) => void
      onReasoning?: (token: string) => void
    } = {}
  ): Promise<{ usage?: TokenUsage; reasoningText?: string }> {
    const r = await this.retryEmpty(
      this.streamOnce(messages, {
        maxTokens: opts.maxTokens,
        signal: opts.signal,
        onText: opts.onDelta,
        onReasoning: opts.onReasoning
      }),
      opts.maxTokens ?? 2000,
      messages,
      { signal: opts.signal, onText: opts.onDelta, onReasoning: opts.onReasoning }
    )
    return { usage: r.usage, reasoningText: r.reasoningText }
  }

  /** 原生 function-calling 流式(工具参数分片自动聚合) */
  async streamChatTools(
    messages: WireMsg[],
    tools: ToolSchema[],
    opts: {
      maxTokens?: number
      signal?: AbortSignal
      onText?: (chunk: string) => void
      onReasoning?: (token: string) => void
    } = {}
  ): Promise<{
    text: string
    toolCalls: Array<{ id?: string; name: string; arguments: string }>
    usage?: TokenUsage
    reasoningText?: string
  }> {
    const r = await this.retryEmpty(
      this.streamOnce(messages, {
        tools,
        maxTokens: opts.maxTokens,
        signal: opts.signal,
        onText: opts.onText,
        onReasoning: opts.onReasoning
      }),
      opts.maxTokens ?? 2000,
      messages,
      { tools, signal: opts.signal, onText: opts.onText, onReasoning: opts.onReasoning }
    )
    return r
  }

  /** 空正文兜底:模型思考(reasoning)耗尽预算时放大 maxTokens 重发一次 */
  private async retryEmpty(
    first: Promise<StreamOnceResult>,
    initialMax: number,
    messages: WireMsg[],
    retryOpts: {
      tools?: ToolSchema[]
      maxTokens?: number
      signal?: AbortSignal
      onText?: (chunk: string) => void
      onReasoning?: (token: string) => void
    }
  ): Promise<StreamOnceResult> {
    const r = await first
    if (!r.text && r.reasoningText && retryOpts.signal?.aborted !== true && initialMax < 8192) {
      return await this.streamOnce(messages, {
        tools: retryOpts.tools,
        maxTokens: Math.min(initialMax * 4, 8192),
        signal: retryOpts.signal,
        onText: retryOpts.onText,
        onReasoning: retryOpts.onReasoning
      })
    }
    return r
  }
}

/**
 * 创建 provider；未启用 / 未配 Key / 未填模型名时返回 null（调用方走提示或本地降级）。
 *
 * `module` 只是给 ai_run 计量用的标签（如 suggest / issue-extract / duty / workbench）：
 * 有了它才答得出「哪个模块总失败、AI 的钱花在哪」。
 */
export function createAiProvider(module = 'ai'): AiProvider | null {
  const cfg = readProviderConfig()
  if (!cfg.enabled || !cfg.apiKey || !cfg.model) return null
  return new OpenAiCompatProvider(cfg, module)
}

/**
 * 测试 OpenAI 兼容通道：发一条最简 chat 请求验证 baseUrl/apiKey/model 是否可用。
 * 不会改动任何已保存配置，返回连通结果与耗时。
 * 连通判据 = HTTP 200 且返回标准 choices[].message 结构（模型无效会 4xx，不会 200）；
 * 不要求 content 非空——思考型模型（DeepSeek Reasoner/GLM 思考等）可能把预算
 * 全部花在 reasoning_content 上而 content 为空，此时通道仍是通的。
 */
export async function testAiConnection(
  cfg: ProviderConfig,
  timeoutMs = 15_000
): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
  const baseUrl = cfg.baseUrl.replace(/\/+$/, '')
  const apiKey = cfg.apiKey.trim()
  const model = cfg.model.trim()
  if (!baseUrl) return { ok: false, error: '请先填写接口地址（Base URL）' }
  if (!apiKey) return { ok: false, error: '请先填写 API Key' }
  if (!model) return { ok: false, error: '请先填写模型名称' }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const startedAt = Date.now()
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        // 预算太小会被思考型模型的 reasoning 耗尽；32 token 足够普通模型答完 ping
        max_tokens: 32
      }),
      signal: ctrl.signal
    })
    const latencyMs = Date.now() - startedAt
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300)
      return { ok: false, error: `HTTP ${res.status}：${body || res.statusText}` }
    }
    let data: {
      choices?: Array<{ message?: { content?: string | null } }>
    }
    try {
      data = (await res.json()) as typeof data
    } catch {
      return {
        ok: false,
        error: '接口已连通，但响应不是有效 JSON（请确认通道为 OpenAI 兼容 /chat/completions）'
      }
    }
    if (!Array.isArray(data.choices) || data.choices.length === 0 || !data.choices[0]?.message) {
      return {
        ok: false,
        error: '接口已连通，但响应缺少 choices/message（请确认通道为 OpenAI 兼容格式）'
      }
    }
    return { ok: true, latencyMs }
  } catch (e) {
    const error = ctrl.signal.aborted
      ? `连接超时（${Math.round(timeoutMs / 1000)}s）`
      : e instanceof Error
        ? e.message
        : String(e)
    return { ok: false, error }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 拉取 OpenAI 兼容通道的模型列表（GET {baseUrl}/models）。
 * 兼容 data[].id（OpenAI 规范）与 models[].model/name（Ollama 等非标准返回）。
 */
export async function listRemoteModels(
  baseUrl: string,
  apiKey: string,
  timeoutMs = 15_000
): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`
  const key = apiKey.trim()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: key ? { Authorization: `Bearer ${key}` } : undefined,
      signal: ctrl.signal
    })
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300)
      return { ok: false, error: `HTTP ${res.status}：${body || res.statusText}` }
    }
    const data = (await res.json()) as {
      data?: Array<{ id?: unknown }>
      models?: Array<{ model?: unknown; name?: unknown; id?: unknown }>
    }
    const raw: unknown[] = Array.isArray(data.data)
      ? (data.data as Array<{ id?: unknown }>)
      : Array.isArray(data.models)
        ? (data.models as Array<{ model?: unknown; name?: unknown; id?: unknown }>)
        : []
    const seen = new Set<string>()
    const models: string[] = []
    for (const item of raw as Array<Record<string, unknown>>) {
      const id = String(item?.id ?? item?.model ?? item?.name ?? '').trim()
      if (id && !seen.has(id)) {
        seen.add(id)
        models.push(id)
      }
      if (models.length >= 300) break // 防止极端大列表拖慢界面
    }
    if (models.length === 0) {
      return {
        ok: false,
        error: '接口已连通，但未返回任何模型（请检查通道类型是否为 OpenAI 兼容）'
      }
    }
    return { ok: true, models }
  } catch (e) {
    const error = ctrl.signal.aborted
      ? `连接超时（${Math.round(timeoutMs / 1000)}s）`
      : e instanceof Error
        ? e.message
        : String(e)
    return { ok: false, error }
  } finally {
    clearTimeout(timer)
  }
}
