import { ipcMain } from 'electron'
import * as wxService from '../services/wechat/wxService'
import { startWatch } from '../services/wechat/watchService'
import { ensure as ensureIssueScheduler } from '../services/feedback/scheduler'
import { startBaseSyncScheduler } from '../services/lark/baseSyncScheduler'
import type { MessageCursor } from '../../shared/types'

export function registerWechatHandlers(): void {
  ipcMain.handle('cs:wx:connect', (_e, wxid: string) => {
    const r = wxService.connect(wxid)
    if (r.ok) {
      ensureIssueScheduler(wxid)
      startBaseSyncScheduler(wxid)
    }
    return r
  })

  ipcMain.handle('cs:wx:getSessions', (_e, wxid: string) => wxService.getSessions(wxid))

  ipcMain.handle(
    'cs:wx:getMessages',
    (_e, wxid: string, sessionId: string, limit?: number, before?: MessageCursor) =>
      wxService.getMessages(wxid, sessionId, limit ?? 50, before)
  )

  ipcMain.handle(
    'cs:wx:getMessagesSince',
    (_e, wxid: string, sessionId: string, sinceSortSeq: number) =>
      wxService.getMessagesSince(wxid, sessionId, sinceSortSeq)
  )

  ipcMain.handle('cs:wx:getRedEnvelopeStatuses', (_e, wxid: string, sessionId: string) =>
    wxService.getRedEnvelopeStatuses(wxid, sessionId)
  )

  ipcMain.handle('cs:wx:getAvatar', (_e, wxid: string, username: string, localOnly?: boolean) =>
    wxService.getAvatarForUser(wxid, username, localOnly === true)
  )

  // 批量解析联系人展示名(备注>昵称>alias)，供「跟进人」等按 username 落库的数据回显；库不可读时返回空表
  ipcMain.handle('cs:wx:contactNames', (_e, wxid: string, usernames: string[]) =>
    wxService.getContactNames(wxid, usernames ?? [])
  )

  ipcMain.handle('cs:wx:startWatch', (_e, wxid: string) => {
    const r = startWatch(wxid)
    if (r.ok) {
      ensureIssueScheduler(wxid)
      startBaseSyncScheduler(wxid)
    }
    return r
  })

  ipcMain.handle('cs:wx:opsStats', (_e, wxid: string, rangeDays?: number) =>
    wxService.getOpsStats(wxid, rangeDays ?? 7)
  )
}
