import { ipcMain } from 'electron'
import {
  countCustomerProfiles,
  listCustomerProfiles,
  removeCustomerTag,
  setCustomerTag,
  updateCustomerFields,
  upsertCustomersFromSessions,
  type SessionCustomerRow
} from '../db/repos/customerRepo'
import { getSessions } from '../services/wechat/wxService'
import type { CustomerStored } from '../../shared/customerProfile'

/**
 * 客户档案 IPC。
 *
 * cs:customers:sync      从会话列表同步「微信侧的事实」（幂等，不碰用户填的字段）
 * cs:customers:list      读全部档案（含标签），渲染端与会话合并后展示
 * cs:customers:setTag / removeTag / setFields
 *
 * 为什么同步放主进程：客户页每次打开都会跑，渲染端逐条 IPC 写库既慢又容易写坏。
 */

export function registerCustomerHandlers(): void {
  ipcMain.handle('cs:customers:sync', (_e, wxid: string) => {
    const acct = String(wxid ?? '').trim()
    if (!acct) return { ok: false as const, error: '缺少账号' }
    try {
      const res = getSessions(acct)
      if (!res.ok || !res.sessions) {
        return { ok: false as const, error: res.error || '会话列表读取失败' }
      }
      // 公众号与折叠分组不是「客户」，与客户页的既有口径保持一致
      const rows: SessionCustomerRow[] = res.sessions
        .filter((s) => !s.isOfficialAccount && !s.isFoldGroup && !!s.username)
        .map((s) => ({
          username: s.username,
          displayName: s.displayName || '',
          remark: s.remark || '',
          nickname: s.nickname || '',
          alias: s.alias || '',
          isGroup: !!s.isGroup,
          lastActiveAt: s.lastTimestamp || null
        }))
      const out = upsertCustomersFromSessions(acct, rows)
      return { ok: true as const, ...out, total: countCustomerProfiles(acct) }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:customers:list', (_e, wxid: string) => {
    const acct = String(wxid ?? '').trim()
    if (!acct) return { ok: false as const, error: '缺少账号' }
    try {
      const map = listCustomerProfiles(acct)
      const items: CustomerStored[] = [...map.values()]
      return { ok: true as const, items }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(
    'cs:customers:setTag',
    (_e, wxid: string, username: string, tag: string, kind?: string) => {
      const acct = String(wxid ?? '').trim()
      const user = String(username ?? '').trim()
      const value = String(tag ?? '').trim()
      if (!acct || !user) return { ok: false as const, error: '缺少账号或客户标识' }
      if (!value) return { ok: false as const, error: '标签不能为空' }
      try {
        setCustomerTag(acct, user, value, kind === 'derived' ? 'derived' : 'manual')
        return { ok: true as const }
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle('cs:customers:removeTag', (_e, wxid: string, username: string, tag: string) => {
    const acct = String(wxid ?? '').trim()
    const user = String(username ?? '').trim()
    if (!acct || !user) return { ok: false as const, error: '缺少账号或客户标识' }
    try {
      return { ok: true as const, removed: removeCustomerTag(acct, user, String(tag ?? '')) }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(
    'cs:customers:setFields',
    (_e, wxid: string, username: string, patch: { source?: string; note?: string }) => {
      const acct = String(wxid ?? '').trim()
      const user = String(username ?? '').trim()
      if (!acct || !user) return { ok: false as const, error: '缺少账号或客户标识' }
      try {
        const changed = updateCustomerFields(acct, user, patch ?? {})
        return { ok: true as const, changed }
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
}
