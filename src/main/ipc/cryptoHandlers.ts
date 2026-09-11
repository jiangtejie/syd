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
import { detectKeyTools, listKeyToolPresets, runKeyTool } from '../services/wechat/keyTools'

/**
 * 「解密一体化」IPC：体检 / 账号发现 / 一键接入 / 预热解密 / 取 key 工具。
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

  /** 检测本机已有的取 key 工具（本仓不分发，只帮用户找） */
  ipcMain.handle('cs:crypto:keyTools', () => {
    try {
      const { tools, dirs } = detectKeyTools()
      return { ok: true as const, tools, scannedDirs: dirs, presets: listKeyToolPresets() }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /** 一键使用某个取 key 工具：按预设模板依次试，命中即校验落库 */
  ipcMain.handle(
    'cs:crypto:keyToolRun',
    async (_e, opts: { wxid: string; command?: string; presetId?: string }) => {
      if (!opts?.wxid) return { ok: false as const, error: '缺少账号', attempts: [] }
      try {
        return await runKeyTool(opts)
      } catch (err) {
        return {
          ok: false as const,
          attempts: [],
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }
  )

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
