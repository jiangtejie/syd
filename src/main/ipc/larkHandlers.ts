import { ipcMain } from 'electron'
import { larkConfigStatus } from '../services/lark/client'
import { testLarkAccess } from '../services/lark/api'
import {
  baseSyncHint,
  baseSyncStatus,
  claimExistingRecords,
  cleanOrphanEvidence,
  ensureEvidenceTable,
  getEvidenceConfig,
  setEvidenceConfig,
  getFieldMap,
  pullIssuesBack,
  resetEvidenceMedia,
  setFieldMap,
  setRawEvidence,
  setSyncEnabled,
  syncEvidenceOut,
  syncIssuesOut,
  syncRepliesOut,
  verifyBaseLink,
  type FieldMap
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

  /**
   * 粘贴链接 → **预览**自检：读 Base 名 / 目标表名 / 现有列 / 将新建列 / 类型冲突 / 主字段 / 回写能力。
   * 不建表、不建列、不写测试、不落配置 —— 先让用户看清"将发生什么"。
   */
  ipcMain.handle('cs:lark:basePreview', async (_e, link: string) => {
    const target = typeof link === 'string' ? link.trim() : ''
    if (!target) return { ok: false as const, error: '请先粘贴多维表格链接' }
    try {
      const r = await verifyBaseLink(target, { preview: true })
      return { ...r, status: snapshot() }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : '预览失败' }
    }
  })

  /** 粘贴链接 → 执行：建表/补列 + 写测试记录 + 落配置（成功后即可同步） */
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

  /** 认领目标表里已有的行（按「议题ID」匹配本地议题），避免重复插入 */
  ipcMain.handle('cs:lark:baseClaim', async () => {
    try {
      const appToken = (getConfig('lark.baseToken') ?? '').trim()
      const tableId = (getConfig('lark.baseTableIssues') ?? '').trim()
      if (!appToken || !tableId) return { ok: false as const, error: '请先完成「验证并建表」' }
      // 认领只依赖本地议题 id(全局唯一),与账号作用域无关
      const claimed = await claimExistingRecords(appToken, tableId)
      return { ok: claimed.ok, claimed, status: snapshot() }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : '认领失败' }
    }
  })

  // ── 议题证据明细(子表) ──

  /** 证据同步配置:开关 + 三重上限(天数 / 每议题条数 / 每条字数) */
  ipcMain.handle(
    'cs:lark:baseEvidence',
    (
      _e,
      patch: {
        enabled?: boolean
        days?: number
        maxPerIssue?: number
        maxChars?: number
        media?: boolean
        maxMediaMB?: number
        maxUploadsPerRound?: number
      } = {}
    ) => {
      try {
        if (patch && Object.keys(patch).length > 0) setEvidenceConfig(patch)
        return { ok: true as const, evidence: getEvidenceConfig(), status: snapshot() }
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : '保存证据配置失败' }
      }
    }
  )

  /** 创建/校验「议题证据」子表,并尝试建立与议题表的关联字段(失败不致命) */
  ipcMain.handle('cs:lark:baseEvidenceSetup', async () => {
    try {
      const appToken = (getConfig('lark.baseToken') ?? '').trim()
      const issuesTableId = (getConfig('lark.baseTableIssues') ?? '').trim()
      if (!appToken) return { ok: false as const, error: '请先完成「验证并建表」' }
      const r = await ensureEvidenceTable(appToken, issuesTableId || undefined)
      return { ok: true as const, ...r, status: snapshot() }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : '创建证据表失败' }
    }
  })

  /** 清理孤儿证据行(议题已删除、远程行残留) */
  ipcMain.handle('cs:lark:baseEvidenceClean', async () => {
    try {
      const r = await cleanOrphanEvidence()
      return { ...r, status: snapshot() }
    } catch (e) {
      return { ok: false as const, removed: 0, error: e instanceof Error ? e.message : '清理失败' }
    }
  })

  /** 列名映射（本地标准列名 → 目标表实际列名） */
  ipcMain.handle('cs:lark:baseFieldMap', (_e, map: FieldMap | null = null) => {
    try {
      if (map) setFieldMap(map)
      return { ok: true as const, fieldMap: getFieldMap(), status: snapshot() }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : '保存列名映射失败' }
    }
  })

  /** 立即同步：默认先拉同事改动再推本地变更（pull=false 时只推，用于「全量核对」） */
  ipcMain.handle('cs:lark:baseSync', async (_e, wxid: string, force?: boolean, pull = true) => {
    if (!wxid) return { ok: false as const, error: '缺少账号' }
    try {
      const pulled = pull ? await pullIssuesBack(wxid) : null
      const r = await syncIssuesOut(wxid, { force: force === true })
      // 影子记录（数字员工回复）一并推：手机上就能审话术
      const replies = await syncRepliesOut(wxid, { force: force === true })
      // 证据明细子表（默认关闭；开启时才推）
      const evidence = await syncEvidenceOut()
      return { ok: r.ok, result: r, pulled, replies, evidence, status: snapshot() }
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
      setConfig('lark.baseLink', '')
      setConfig('lark.baseName', '')
      setConfig('lark.baseTableIssuesName', '')
      setConfig('lark.canWriteBack', '')
      setConfig('lark.baseTableIssues', '')
      setConfig('lark.baseTableReplies', '')
      setConfig('lark.primaryField', '')
      setConfig('lark.fieldMap', '')
      setConfig('lark.fieldConflicts', '')
      setConfig('lark.sync.history', '')
      setConfig('lark.baseTableEvidence', '')
      setConfig('lark.evidence.linkField', '')
      setConfig('lark.evidence.enabled', '0')
      setConfig('lark.sync.evidenceAt', '')
      setConfig('lark.sync.lastEvidence', '')
      setConfig('lark.evidence.media', '0')
      // 素材 token / 附件写入状态都是 Base 级的,清配置时一并作废
      resetEvidenceMedia()
      setConfig('lark.sync.enabled', '0')
      return { ok: true as const, status: snapshot() }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : '清除失败' }
    }
  })
}
