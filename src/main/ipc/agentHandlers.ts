import { ipcMain } from 'electron'
import type { AiAgentInput } from '../../shared/types'
import {
  getDefaultAgent,
  listAgents,
  removeAgent,
  saveAgent,
  setDefaultAgent
} from '../db/repos/agentRepo'

/**
 * 智能体（客服人设）IPC。
 * cs:agent:list / save / remove / setDefault / default
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

  ipcMain.handle('cs:agent:remove', (_e, id: string) => {
    if (!id) return { ok: false as const, error: '参数错误' }
    try {
      return removeAgent(id)
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:agent:setDefault', (_e, id: string) => {
    if (!id) return { ok: false as const, error: '参数错误' }
    try {
      setDefaultAgent(id)
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
