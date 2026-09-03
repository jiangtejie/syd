import { getConfig } from '../../db/repos/config'

/**
 * LLM Provider 抽象（T7，方案 §4.4 AI 生成层）。
 * 支持任意 OpenAI 兼容接口（/chat/completions），配置存 app_config：
 *   ai.baseUrl  ai.apiKey  ai.model  ai.enabled
 */

export interface AiProvider {
  /** 系统 + 用户消息，返回模型输出文本 */
  complete(system: string, user: string, opts?: { maxTokens?: number }): Promise<string>
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
  const apiKey = getConfig('ai.apiKey') || ''
  const model = getConfig('ai.model') || 'gpt-4o-mini'
  const enabled = getConfig('ai.enabled') === '1' || getConfig('ai.enabled') === 'true'
  return { baseUrl, apiKey, model, enabled }
}

class OpenAiCompatProvider implements AiProvider {
  readonly name = 'openai-compat'
  constructor(private cfg: ProviderConfig) {}

  async complete(system: string, user: string, opts?: { maxTokens?: number }): Promise<string> {
    const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.cfg.apiKey}`
      },
      body: JSON.stringify({
        model: this.cfg.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        temperature: 0.7,
        max_tokens: opts?.maxTokens ?? 600
      })
    })
    if (!res.ok) {
      throw new Error(`LLM 调用失败 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = data.choices?.[0]?.message?.content?.trim()
    if (!content) throw new Error('LLM 返回为空')
    return content
  }
}

/** 创建 provider；未配置时返回 null（调用方走模板降级） */
export function createAiProvider(): AiProvider | null {
  const cfg = readProviderConfig()
  if (!cfg.enabled || !cfg.apiKey) return null
  return new OpenAiCompatProvider(cfg)
}

/**
 * 测试 OpenAI 兼容通道：发一条最简 chat 请求验证 baseUrl/apiKey/model 是否可用。
 * 不会改动任何已保存配置，返回连通结果与耗时。
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
        max_tokens: 4
      }),
      signal: ctrl.signal
    })
    const latencyMs = Date.now() - startedAt
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300)
      return { ok: false, error: `HTTP ${res.status}：${body || res.statusText}` }
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = data.choices?.[0]?.message?.content
    if (!content) {
      return { ok: false, error: '接口已连通但返回内容为空，请检查模型名称是否正确' }
    }
    return { ok: true, latencyMs }
  } catch (e) {
    const error =
      ctrl.signal.aborted
        ? `连接超时（${Math.round(timeoutMs / 1000)}s）`
        : e instanceof Error
          ? e.message
          : String(e)
    return { ok: false, error }
  } finally {
    clearTimeout(timer)
  }
}
