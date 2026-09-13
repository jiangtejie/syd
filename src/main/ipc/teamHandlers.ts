import { ipcMain } from 'electron'
import { listTeamMembers, removeTeamMember, saveTeamMember } from '../db/repos/teamRepo'

/**
 * 团队客服成员 IPC（全局标识，按微信账号作用域）。
 * cs:team:list / save / remove
 */

export function registerTeamHandlers(): void {
  ipcMain.handle('cs:team:list', (_e, accountWxid: string) => {
    if (!accountWxid) return { ok: false as const, error: '缺少账号' }
    try {
      return { ok: true as const, members: listTeamMembers(accountWxid) }
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  })

  ipcMain.handle('cs:team:save', (_e, accountWxid: string, username: string, label?: string) => {
    if (!accountWxid || !username) return { ok: false as const, error: '缺少账号或联系人标识' }
    try {
      const member = saveTeamMember(accountWxid, username, label ?? '')
      return { ok: true as const, member }
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  })

  ipcMain.handle('cs:team:remove', (_e, accountWxid: string, username: string) => {
    if (!accountWxid || !username) return { ok: false as const, error: '缺少账号或联系人标识' }
    try {
      removeTeamMember(accountWxid, username)
      return { ok: true as const }
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  })
}
