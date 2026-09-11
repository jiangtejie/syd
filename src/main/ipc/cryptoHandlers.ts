import { ipcMain } from 'electron'
import * as wxService from '../services/wechat/wxService'
import { getKeyStatus } from '../services/keyStoreService'
import { ensure as ensureIssueScheduler } from '../services/feedback/scheduler'
import { startBaseSyncScheduler } from '../services/lark/baseSyncScheduler'
import {
  accountReadiness,
  discoverAccounts,
  onboardAccount,
  warmupAccount
} from '../services/wechat/cryptoReadiness'

/**
 * 「解密一体化」IPC：体检 / 账号发现 / 一键接入 / 预热解密。
 *
 * 这些能力此前散在设置页各处（密钥、图片密钥、连接、监控），运营闲置机器时要逐个试；
 * 这里收成一组可编排的接口，界面上一键跑完并给出逐项结果。
 */
export function registerCryptoHandlers(): void {
  ipcMain.handle('cs:crypto:discover', () => {
    try {
      return { ok: true as const, accounts: discoverAccounts() }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:crypto:readiness', (_e, wxid: string) => {
    if (!wxid || typeof wxid !== 'string') return { ok: false as const, error: '缺少账号' }
    try {
      return { ok: true as const, report: accountReadiness(wxid) }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:crypto:warmup', (_e, wxid: string) => {
    if (!wxid || typeof wxid !== 'string') return { ok: false as const, error: '缺少账号' }
    try {
      return { ok: true as const, report: warmupAccount(wxid) }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /** 一键接入：定位账号 → 取密钥 → 图片密钥 → 预热 → 连接并启动监控 */
  ipcMain.handle(
    'cs:crypto:onboard',
    async (_e, opts?: { wxid?: string; dbPath?: string; keyHex?: string; connect?: boolean }) => {
      try {
        const report = await onboardAccount(opts ?? {})
        let connected: { ok: boolean; error?: string } | null = null
        if (report.ok && opts?.connect !== false) {
          const r = wxService.connect(report.wxid)
          connected = { ok: r.ok, error: r.error }
          if (r.ok) {
            ensureIssueScheduler(report.wxid)
            startBaseSyncScheduler(report.wxid)
          }
        }
        // 覆盖账号目录：首次接入后把目录写进密钥档案，后续各模块都靠它定位
        const info = getKeyStatus(report.wxid)
        return { ok: report.ok, report, connected, dbPath: info.dbPath }
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
}
