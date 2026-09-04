import { getConfig } from '../../db/repos/config'
import { openSecret } from '../secrets'
import type { ChatTurn } from '../../../shared/types'

/**
 * LLM Provider 抽象（T7，方案 §4.4 AI 生成层）。
 * 支持任意 OpenAI 兼容接口（/chat/completions），配置存 app_config：
 *   ai.baseUrl  ai.apiKey  ai.model  ai.enabled
 * ai.apiKey 落库为 safeStorage 密文（enc1: 前缀），读取时在此统一解密；明文形态兼容。
 */

export interface AiProvider {
  /** 系统 + 用户消息，返回模型输出文本 */
  complete(system: string, user: string, opts?: { maxTokens?: number }): Promise<string>
  /** 多轮流式对话（AI 助手用）：SSE 逐 token 回调，signal 可中断 */
  streamChat(
    messages: ChatTurn[],
    opts?: {
      maxTokens?: number
      signal?: AbortSignal
      onDelta?: (token: string) => void
      onReasoning?: (token: string) => void
    }
  ): Promise<string>
  readonly name: string
}

export interface ProviderConfig {
  baseUrl: string
  apiKey: string
  model: string
  enabled: boolean
}

export function readProviderConfig(): ProviderConfig {
  const baseUrl = (getConfig('ai.baseUrl') || 'https://api.openai.com/v1').replace(/\/+$/, '')
  const apiKey = openSecret(getConfig('ai.apiKey'))
  const model = getConfig('ai.model')?.trim() || ''
  const enabled = getConfig('ai.enabled') === '1' || getConfig('ai.enabled') === 'true'
  return { baseUrl, apiKey, model, enabled }
}

class OpenAiCompatProvider implements AiProvider {
  readonly name = 'openai-compat'
  constructor(private cfg: ProviderConfig) {}

  async complete(system: string, user: string, opts?: { maxTokens?: number }): Promise<string> {
    const model = this.cfg.model
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
    // 思考型模型（DeepSeek Reasoner/R1 等）的 reasoning 可能占用输出预算；
    // 预算截断（finish_reason=length 且正文为空）时自动放大重试，上限 8192
    let maxTokens = opts?.maxTokens ?? 600

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
          ...(withTemp ? { temperature: 0.7 } : {}),
          max_tokens: maxTokens
        })
      })

    const ensureOk = async (res: Response): Promise<void> => {
      if (!res.ok) {
        throw new Error(`LLM 调用失败 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
      }
    }

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
        throw new Error(`LLM 调用失败 HTTP ${res.status}: ${errText.slice(0, 200)}`)
      }
    }
    await ensureOk(res)

    // 最多两轮：解析正文；截断且正文为空 → 放大预算重试一次
    for (let round = 0; ; round++) {
      const data = (await res.json()) as {
        choices?: Array<{
          message?: { content?: string | null; reasoning_content?: string | null }
          finish_reason?: string
        }>
      }
      const content = data.choices?.[0]?.message?.content?.trim()
      if (content) return content
      const msg = data.choices?.[0]?.message
      const reasoning = msg?.reasoning_content
      const finishedByLength = data.choices?.[0]?.finish_reason === 'length'
      if (finishedByLength && round === 0 && maxTokens < 8192) {
        maxTokens = Math.min(maxTokens * 4, 8192)
        res = await post(false) // 思考型模型通常不接受 temperature，放大预算后不带该参数
        await ensureOk(res)
        continue
      }
      // 放大重试仍空 → 给出可诊断信息（思考型模型预算仍不足，或响应结构异常）
      throw new Error(
        reasoning || finishedByLength
          ? '模型思考过长耗尽输出预算、未生成正文（可重试或改用非思考模型）'
          : 'LLM 返回为空（响应结构异常或无内容）'
      )
    }
  }

  /** 多轮流式：SSE 增量；外部 signal 可中断；400 且不支持 temperature 时自动去参重试一次 */
  async streamChat(
    messages: ChatTurn[],
    opts: {
      maxTokens?: number
      signal?: AbortSignal
      onDelta?: (token: string) => void
      onReasoning?: (token: string) => void
    } = {}
  ): Promise<string> {
    const model = this.cfg.model
    const maxTokens = opts.maxTokens ?? 2000

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
          ...(withTemp ? { temperature: 0.7 } : {}),
          max_tokens: maxTokens
        }),
        signal: opts.signal
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
        throw new Error(`LLM 调用失败 HTTP ${res.status}: ${errText.slice(0, 200)}`)
      }
    }
    if (!res.ok) {
      throw new Error(`LLM 调用失败 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }

    if (!res.body) throw new Error('LLM 流式响应无 body')
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let content = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
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
            if (data === '[DONE]') return content
            try {
              const json = JSON.parse(data) as {
                choices?: Array<{
                  delta?: { content?: string | null; reasoning_content?: string | null }
                }>
              }
              const delta = json.choices?.[0]?.delta
              if (typeof delta?.content === 'string' && delta.content.length > 0) {
                content += delta.content
                opts.onDelta?.(delta.content)
              }
              if (
                typeof delta?.reasoning_content === 'string' &&
                delta.reasoning_content.length > 0
              ) {
                opts.onReasoning?.(delta.reasoning_content)
              }
            } catch {
              /* 忽略无法解析的分片 */
            }
          }
        }
      }
      return content
    } finally {
      reader.releaseLock()
    }
  }
}

/** 创建 provider；未启用 / 未配 Key / 未填模型名时返回 null（调用方走提示或本地降级） */
export function createAiProvider(): AiProvider | null {
  const cfg = readProviderConfig()
  if (!cfg.enabled || !cfg.apiKey || !cfg.model) return null
  return new OpenAiCompatProvider(cfg)
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
