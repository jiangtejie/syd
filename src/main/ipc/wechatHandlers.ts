import { ipcMain } from 'electron'
import * as wxService from '../services/wechat/wxService'
import { startWatch } from '../services/wechat/watchService'
import { ensure as ensureIssueScheduler } from '../services/feedback/scheduler'
import { startBaseSyncScheduler } from '../services/lark/baseSyncScheduler'
import { getKeyStatus, importKey, testKey } from '../services/keyStoreService'
import { scanWeChatKey } from '../services/wechat/keyScan'
import { deriveImageKeys } from '../services/media/imageKeys'
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

  /**
   * 图片密钥：从账号目录的 *_t.dat 模板本地推导 XOR，并用模板探测段校验 AES。
   * 不需要任何原生依赖（不读内存、不调 DLL）；失败信息直接给「为什么推不出来」。
   */
  ipcMain.handle('cs:wx:deriveImageKeys', (_e, wxid: string, knownAesKey?: string) => {
    if (!wxid) return { ok: false as const, error: '缺少账号' }
    const info = getKeyStatus(wxid)
    const accountDir = info.dbPath ?? ''
    if (!accountDir) {
      return { ok: false as const, error: '还没导入微信密钥/数据目录，无法定位账号目录' }
    }
    try {
      return deriveImageKeys(accountDir, knownAesKey)
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : '推导失败' }
    }
  })

  /**
   * 库密钥自动获取（多来源：可选组件 / 外部工具 / 本地文件）。
   * 任何候选都必须先过页 1 校验才落库；每个来源的结果照实回传，界面能说清「到底卡在哪」。
   */
  ipcMain.handle('cs:wx:scanDbKey', async (_e, wxid: string) => {
    if (!wxid) return { ok: false as const, error: '缺少账号', attempts: [] }
    const info = getKeyStatus(wxid)
    const scanned = await scanWeChatKey({ wxid, dbPath: info.dbPath ?? '' })
    if (!scanned.ok || !scanned.key) {
      return { ok: false as const, error: scanned.error, attempts: scanned.attempts }
    }
    const saved = importKey(wxid, scanned.key, 'registry', info.dbPath ?? '')
    if (!saved.success) {
      return { ok: false as const, error: saved.error, attempts: scanned.attempts }
    }
    const tested = testKey(wxid)
    return {
      ok: true as const,
      provider: scanned.provider,
      valid: tested.success,
      error: tested.success ? undefined : tested.error,
      attempts: scanned.attempts
    }
  })

  ipcMain.handle('cs:wx:opsStats', (_e, wxid: string, rangeDays?: number) =>
    wxService.getOpsStats(wxid, rangeDays ?? 7)
  )
}
