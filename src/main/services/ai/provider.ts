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
