import { ipcMain } from 'electron'
import type { AiAgentInput } from '../../shared/types'
import { getDefaultAgent, listAgents, saveAgent } from '../db/repos/agentRepo'

/**
 * 智能体（统一人设）IPC。
 * cs:agent:list / save
 * 收敛说明:全端共用单条人设,「删除/设默认/多智能体」入口已下线(数据层函数已随 UI 移除)。
 */

export function registerAgentHandlers(): void {
  ipcMain.handle('cs:agent:list', () => {
    try {
      const agents = listAgents()
      const def = getDefaultAgent()
      return { ok: true as const, agents, defaultId: def?.id ?? null }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:agent:save', (_e, input: AiAgentInput | undefined) => {
    if (!input || typeof input !== 'object') return { ok: false as const, error: '参数错误' }
    try {
      const agent = saveAgent(input)
      return { ok: true as const, agent }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
