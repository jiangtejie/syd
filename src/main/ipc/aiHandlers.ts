import { ipcMain } from 'electron'
import type { AiGenOptions, ChatMessage } from '../../shared/types'
import { generateSuggestions } from '../services/ai/suggest'
import { readProviderConfig, testAiConnection } from '../services/ai/provider'

/**
 * AI 建议生成 IPC（T7）。
 * cs:ai:generateReply(sessionName, messages, opts) → Result<{ candidates, llm }>
 * 消息上下文由渲染端传入（真实库与 mock 数据均可），AI 层不依赖微信库。
 * cs:ai:test({ baseUrl?, apiKey?, model? }) → 用传入/已保存参数测试 OpenAI 兼容通道连通性
 */
export function registerAiHandlers(): void {
  ipcMain.handle(
    'cs:ai:generateReply',
    async (_e, sessionName: string, messages: ChatMessage[], opts?: AiGenOptions) => {
      try {
        const list = Array.isArray(messages) ? messages : []
        const res = await generateSuggestions(sessionName ?? '', list, opts ?? {})
        return { ok: true, candidates: res.candidates, llm: res.llm } as const
      } catch (e) {
        console.error('[ai] generateReply failed', e)
        return {
          ok: false,
          error: e instanceof Error ? e.message : '生成建议失败'
        } as const
      }
    }
  )

  ipcMain.handle(
    'cs:ai:test',
    async (
      _e,
      input?: { baseUrl?: string; apiKey?: string; model?: string; timeoutMs?: number }
    ) => {
      // 未显式传参的字段回落到已保存配置（设置页未保存先测试时传当前表单值）
      const saved = readProviderConfig()
      const merged = { ...saved, ...(input ?? {}) }
      const res = await testAiConnection(merged, input?.timeoutMs)
      return res.ok
        ? { ok: true as const, latencyMs: res.latencyMs }
        : { ok: false as const, error: res.error }
    }
  )
}
