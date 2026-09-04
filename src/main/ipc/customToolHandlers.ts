import { ipcMain } from 'electron'
import { listCustomTools, saveCustomTool, removeCustomTool } from '../db/repos/customToolRepo'
import type { CustomToolInput } from '../../shared/types'

/** 自定义 HTTP 工具 IPC。变更即时生效(每次对话按库重建注册表)。 */
export function registerCustomToolHandlers(): void {
  ipcMain.handle('cs:tool:list', () => {
    try {
      return { ok: true as const, tools: listCustomTools() }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:tool:save', (_e, input: CustomToolInput) => {
    try {
      return saveCustomTool(input ?? ({} as CustomToolInput))
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:tool:remove', (_e, id: number) => {
    if (!Number.isInteger(id)) return { ok: false as const, error: '参数错误' }
    try {
      if (!removeCustomTool(id)) return { ok: false as const, error: '工具不存在' }
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
