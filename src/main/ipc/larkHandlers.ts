import { ipcMain } from 'electron'
import { larkConfigStatus } from '../services/lark/client'
import { testLarkAccess } from '../services/lark/api'
import {
  baseSyncHint,
  baseSyncStatus,
  pullIssuesBack,
  setRawEvidence,
  setSyncEnabled,
  syncIssuesOut,
  verifyBaseLink
} from '../services/lark/baseSync'
import { getConfig, setConfig } from '../db/repos/config'

/**
 * 飞书云文档 IPC(cs:lark:*):设置页的状态展示与连通性测试。
 * 凭证本身走 cs:config:set(lark.appId / lark.appSecret,lark.appSecret 自动加封),
 * 这里只提供「是否已配置/来源」与「按链接实测能否读到」。
 */
export function registerLarkHandlers(): void {
  ipcMain.handle('cs:lark:status', () => {
    try {
      return { ok: true as const, ...larkConfigStatus() }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : '读取飞书配置失败' }
    }
  })

  ipcMain.handle('cs:lark:test', async (_e, url: string) => {
    const target = typeof url === 'string' ? url.trim() : ''
    if (!target) return { ok: false as const, error: '请先填写要测试的飞书链接' }
    try {
      const r = await testLarkAccess(target)
      return r.ok ? { ok: true as const, text: r.text } : { ok: false as const, error: r.text }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : '测试失败' }
    }
  })

  // ── 议题 → 多维表格（Base）同步 ──
  const snapshot = (): Record<string, unknown> => ({
    ...baseSyncStatus(),
    hint: baseSyncHint(),
    link: (getConfig('lark.baseToken') ?? '').trim()
  })

  ipcMain.handle('cs:lark:baseStatus', () => {
    try {
      return { ok: true as const, status: snapshot() }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : '读取同步状态失败' }
    }
  })

  /** 粘贴链接 → 验证读写 + 自动建表建字段（成功后落配置） */
  ipcMain.handle('cs:lark:baseVerify', async (_e, link: string) => {
    const target = typeof link === 'string' ? link.trim() : ''
    if (!target) return { ok: false as const, error: '请先粘贴多维表格链接' }
    try {
      const r = await verifyBaseLink(target)
      return { ...r, status: snapshot() }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : '验证失败' }
    }
  })

  /** 立即同步：默认先拉同事改动再推本地变更（pull=false 时只推，用于「全量核对」） */
  ipcMain.handle('cs:lark:baseSync', async (_e, wxid: string, force?: boolean, pull = true) => {
    if (!wxid) return { ok: false as const, error: '缺少账号' }
    try {
      const pulled = pull ? await pullIssuesBack(wxid) : null
      const r = await syncIssuesOut(wxid, { force: force === true })
      return { ok: r.ok, result: r, pulled, status: snapshot() }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : '同步失败' }
    }
  })

  /** 只拉取同事在表格里的改动（状态/跟进人 → 本地） */
  ipcMain.handle('cs:lark:basePull', async (_e, wxid: string) => {
    if (!wxid) return { ok: false as const, error: '缺少账号' }
    try {
      const pulled = await pullIssuesBack(wxid)
      return { ok: pulled.ok, pulled, status: snapshot() }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : '拉取失败' }
    }
  })

  ipcMain.handle(
    'cs:lark:baseConfig',
    (_e, patch: { enabled?: boolean; rawEvidence?: boolean } = {}) => {
      try {
        if (typeof patch.enabled === 'boolean') setSyncEnabled(patch.enabled)
        if (typeof patch.rawEvidence === 'boolean') setRawEvidence(patch.rawEvidence)
        return { ok: true as const, status: snapshot() }
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : '保存失败' }
      }
    }
  )

  ipcMain.handle('cs:lark:baseClear', () => {
    try {
      setConfig('lark.baseToken', '')
      setConfig('lark.baseTableIssues', '')
      setConfig('lark.baseTableReplies', '')
      setConfig('lark.sync.enabled', '0')
      return { ok: true as const, status: snapshot() }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : '清除失败' }
    }
  })
}
