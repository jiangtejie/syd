import { ipcMain } from 'electron'
import { listMemories, saveMemory, removeMemory } from '../db/repos/memoryRepo'
import type { AgentMemoryInput } from '../../shared/types'

/** 常驻记忆 IPC。 */
export function registerMemoryHandlers(): void {
  ipcMain.handle('cs:memory:list', () => {
    try {
      return { ok: true as const, items: listMemories() }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:memory:save', (_e, input: AgentMemoryInput) => {
    try {
      return saveMemory(input ?? ({} as AgentMemoryInput))
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:memory:remove', (_e, id: number) => {
    if (!Number.isInteger(id)) return { ok: false as const, error: '参数错误' }
    try {
      if (!removeMemory(id)) return { ok: false as const, error: '条目不存在' }
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
