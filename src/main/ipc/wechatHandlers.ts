import { ipcMain } from 'electron'
import * as wxService from '../services/wechat/wxService'
import { startWatch, stopWatch, listWatchWxids } from '../services/wechat/watchService'
import type { MessageCursor } from '../../shared/types'

export function registerWechatHandlers(): void {
  ipcMain.handle('cs:wx:connect', (_e, wxid: string) => wxService.connect(wxid))

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

  ipcMain.handle('cs:wx:startWatch', (_e, wxid: string) => startWatch(wxid))
  ipcMain.handle('cs:wx:stopWatch', (_e, wxid: string) => {
    stopWatch(wxid)
    return { ok: true }
  })
  ipcMain.handle('cs:wx:listWatch', () => listWatchWxids())
}
