import { ipcMain } from 'electron'
import type { AiGenOptions, ChatMessage } from '../../shared/types'
import { generateSuggestions } from '../services/ai/suggest'

/**
 * AI 建议生成 IPC（T7）。
 * cs:ai:generateReply(sessionName, messages, opts) → Result<{ candidates, llm }>
 * 消息上下文由渲染端传入（真实库与 mock 数据均可），AI 层不依赖微信库。
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
}
