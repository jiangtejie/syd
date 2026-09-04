import { ipcMain } from 'electron'
import { listMcpServers, saveMcpServer, removeMcpServer } from '../db/repos/mcpRepo'
import { flushMcpCache } from '../services/ai/chat/mcp'
import type { McpServerInput } from '../../shared/types'

/** MCP 服务器配置 IPC。变更后清理运行缓存(下次对话按新配置重建)。 */
export function registerMcpHandlers(): void {
  ipcMain.handle('cs:mcp:list', () => {
    try {
      return { ok: true as const, servers: listMcpServers() }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:mcp:save', (_e, input: McpServerInput) => {
    try {
      const res = saveMcpServer(input ?? ({} as McpServerInput))
      if (res.ok) flushMcpCache()
      return res
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:mcp:remove', (_e, id: number) => {
    if (!Number.isInteger(id)) return { ok: false as const, error: '参数错误' }
    try {
      if (!removeMcpServer(id)) return { ok: false as const, error: '服务器不存在' }
      flushMcpCache()
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
