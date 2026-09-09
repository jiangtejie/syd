import { clipboard, ipcMain, nativeImage } from 'electron'
import { getGrowthConfig, setGrowthConfigField } from '../services/growth/config'
import { runCrawl } from '../services/growth/collector/service'
import {
  ingestShareText,
  queryContentDetail,
  queryContents,
  patchContent
} from '../services/growth/warehouse/service'
import {
  deleteSubscription,
  getSubscription,
  growthStats,
  insertSubscription,
  listSubscriptions,
  recentCrawlTasks,
  setSubscriptionEnabled,
  updateSubscription
} from '../db/repos/growthOpsRepo'
import { deleteContent } from '../db/repos/growthRepo'
import { importLocalMaterials } from '../services/growth/collector/localImport'
import { exportPublishPackage } from '../services/growth/publisher/exporter'
import { redownloadMissingMedia } from '../services/growth/collector/media/redownload'
import { listMetricViews, listRemixOutputViews } from '../db/repos/growthOpsRepo'
import { batchDeleteContents, batchPatchContents } from '../db/repos/growthRepo'
import { growthOverview } from '../db/repos/growthOpsRepo'
import { existsSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { getGrowthMediaDir } from '../services/paths'
import type { GrowthSubscriptionInput } from '../../shared/growth'
import { clampInt } from './_util'

/**
 * 营销增长(growth)IPC: cs:growth:*。
 * 与既有域保持一致: 参数在入口处做基本校验, 错误统一回 { ok:false, error }。
 */

const SOURCE_TYPES = new Set<string>(['thirdparty', 'official', 'manual'])
const TARGET_KINDS = new Set<string>(['keyword', 'account', 'topic', 'rank'])

function err<T = never>(error: string): { ok: false; error: string } & T {
  return { ok: false, error } as { ok: false; error: string } & T
}

function ok<T>(value: T): { ok: true } & T {
  return { ok: true, ...value }
}

export function registerGrowthHandlers(): void {
  ipcMain.handle('cs:growth:stats', () => {
    const cfg = getGrowthConfig()
    return ok({ stats: growthStats(cfg.autoEnabled, cfg.provider) })
  })

  ipcMain.handle('cs:growth:listContent', (_e, filter?: unknown) => {
    const f = (filter ?? {}) as Record<string, unknown>
    const result = queryContents({
      keyword: typeof f.keyword === 'string' ? f.keyword.slice(0, 100) : undefined,
      origin: typeof f.origin === 'string' ? f.origin.slice(0, 32) || undefined : undefined,
      usage: typeof f.usage === 'string' ? f.usage.slice(0, 32) || undefined : undefined,
      status: typeof f.status === 'string' ? f.status.slice(0, 32) || undefined : undefined,
      noDecomp: f.noDecomp === true || f.noDecomp === 1,
      sort: f.sort === 'score' || f.sort === 'likes' ? f.sort : 'created',
      limit: clampInt(f.limit, 100, 1, 500),
      offset: clampInt(f.offset, 0, 0, 1_000_000)
    })
    return ok(result)
  })

  ipcMain.handle('cs:growth:getContent', (_e, id: unknown) => {
    const cid = clampInt(id, 0, 1, Number.MAX_SAFE_INTEGER)
    if (!cid) return err('非法素材 ID')
    const detail = queryContentDetail(cid)
    if (!detail) return err('素材不存在')
    const view = {
      ...detail,
      remixOutputs: listRemixOutputViews(cid, 12),
      metrics: listMetricViews(cid, 6)
    }
    return ok({ item: view })
  })

  ipcMain.handle('cs:growth:ingestLink', async (_e, text: unknown) => {
    try {
      if (typeof text !== 'string' || text.trim().length === 0 || text.length > 10_000) {
        return err('请粘贴完整的小红书/抖音分享链接或口令')
      }
      const res = await ingestShareText(text)
      return res.ok ? ok({ item: res.item, existed: res.existed }) : err(res.error ?? '入库失败')
    } catch (e) {
      return err(e instanceof Error ? e.message : '入库失败')
    }
  })

  ipcMain.handle('cs:growth:patchContent', (_e, id: unknown, patch: unknown) => {
    const cid = clampInt(id, 0, 1, Number.MAX_SAFE_INTEGER)
    if (!cid) return err('非法素材 ID')
    const p = (patch ?? {}) as Record<string, unknown>
    const usage = typeof p.usage === 'string' ? p.usage : undefined
    const status = typeof p.status === 'string' ? p.status : undefined
    const note = typeof p.note === 'string' ? p.note.slice(0, 500) : undefined
    if (usage === undefined && status === undefined && note === undefined) {
      return err('无可更新字段')
    }
    const done = patchContent(cid, { usage, status, note } as never)
    return done ? ok({}) : err('素材不存在')
  })

  ipcMain.handle('cs:growth:removeContent', (_e, id: unknown) => {
    const cid = clampInt(id, 0, 1, Number.MAX_SAFE_INTEGER)
    if (!cid) return err('非法素材 ID')
    deleteContent(cid)
    return ok({})
  })

  ipcMain.handle('cs:growth:listSubscriptions', () => ok({ subscriptions: listSubscriptions() }))

  ipcMain.handle('cs:growth:saveSubscription', (_e, input: unknown) => {
    const raw = input as Record<string, unknown>
    const target = typeof raw.target === 'string' ? raw.target.trim().slice(0, 120) : ''
    if (!target) return err('订阅目标不能为空')
    const sourceType = SOURCE_TYPES.has(raw.sourceType as string)
      ? (raw.sourceType as string)
      : 'thirdparty'
    const targetKind = TARGET_KINDS.has(raw.targetKind as string)
      ? (raw.targetKind as string)
      : 'keyword'
    const input2: GrowthSubscriptionInput = {
      name: typeof raw.name === 'string' ? raw.name.trim().slice(0, 60) : '',
      sourceType: sourceType as GrowthSubscriptionInput['sourceType'],
      vendor: typeof raw.vendor === 'string' ? raw.vendor.trim().slice(0, 64) : '',
      city: typeof raw.city === 'string' ? raw.city.trim().slice(0, 32) : '',
      bizType: typeof raw.bizType === 'string' ? raw.bizType.trim().slice(0, 32) : '',
      targetKind: targetKind as GrowthSubscriptionInput['targetKind'],
      target,
      storeId: null,
      enabled: raw.enabled === true || raw.enabled === '1' || raw.enabled === 1,
      intervalHours: clampInt(raw.intervalHours, 24, 1, 168)
    }
    const id = Number(raw.id)
    if (Number.isFinite(id) && id > 0) {
      if (!getSubscription(id)) return err('订阅不存在')
      updateSubscription(id, input2)
      return ok({ id })
    }
    const created = insertSubscription(input2)
    return ok({ id: created })
  })

  ipcMain.handle('cs:growth:setSubscriptionEnabled', (_e, id: unknown, enabled: unknown) => {
    const sid = clampInt(id, 0, 1, Number.MAX_SAFE_INTEGER)
    if (!sid) return err('非法订阅 ID')
    setSubscriptionEnabled(sid, enabled === true || enabled === 1 || enabled === '1')
    return ok({})
  })

  ipcMain.handle('cs:growth:deleteSubscription', (_e, id: unknown) => {
    const sid = clampInt(id, 0, 1, Number.MAX_SAFE_INTEGER)
    if (!sid) return err('非法订阅 ID')
    deleteSubscription(sid)
    return ok({})
  })

  ipcMain.handle('cs:growth:runCrawl', async (_e, id: unknown) => {
    const sid = clampInt(id, 0, 1, Number.MAX_SAFE_INTEGER)
    if (!sid) return err('非法订阅 ID')
    const out = await runCrawl(sid, 'manual')
    return out.ok
      ? ok({ fetched: out.fetched, inserted: out.inserted })
      : err(out.error ?? '采集失败')
  })

  ipcMain.handle('cs:growth:recentTasks', (_e, limit: unknown) => {
    return ok({ tasks: recentCrawlTasks(clampInt(limit, 10, 1, 100)) })
  })

  ipcMain.handle('cs:growth:configGet', () => {
    const cfg = getGrowthConfig()
    return ok({
      autoEnabled: cfg.autoEnabled,
      provider: cfg.provider,
      providerApiKey: cfg.apiKey
    })
  })

  // ── 剪贴板复制 ──
  ipcMain.handle('cs:growth:copyClipboard', (_e, payload: unknown) => {
    const p = (payload ?? {}) as Record<string, unknown>
    const text = typeof p.text === 'string' ? p.text : ''
    const relPath = typeof p.relPath === 'string' ? p.relPath : ''
    let image: Electron.NativeImage | null = null
    if (relPath) {
      const base = getGrowthMediaDir()
      const file = resolve(base, relPath)
      if (file.startsWith(base + sep) && existsSync(file)) {
        const img = nativeImage.createFromPath(file)
        if (!img.isEmpty()) image = img
      }
    }
    if (image) clipboard.write({ text, image })
    else if (text) clipboard.writeText(text)
    else return err('没有可复制的内容')
    return ok({})
  })

  // ── 批量 / 上传 / 导出 / 重下载 / 概览 ──
  ipcMain.handle('cs:growth:batchPatch', (_e, ids: unknown, patch: unknown) => {
    const list = Array.isArray(ids) ? ids.map((v) => clampInt(v, 0, 1, Number.MAX_SAFE_INTEGER)).filter(Boolean) : []
    if (list.length === 0 || list.length > 200) return err('请选择 1-200 条素材')
    const p = (patch ?? {}) as Record<string, unknown>
    const usage = typeof p.usage === 'string' ? p.usage : undefined
    const status = typeof p.status === 'string' ? p.status : undefined
    try {
      const done = batchPatchContents(list, { usage, status } as never)
      return ok({ updated: done })
    } catch (e) {
      return err(e instanceof Error ? e.message : '批量更新失败')
    }
  })

  ipcMain.handle('cs:growth:batchRemove', (_e, ids: unknown) => {
    const list = Array.isArray(ids) ? ids.map((v) => clampInt(v, 0, 1, Number.MAX_SAFE_INTEGER)).filter(Boolean) : []
    if (list.length === 0 || list.length > 200) return err('请选择 1-200 条素材')
    try {
      return ok({ removed: batchDeleteContents(list) })
    } catch (e) {
      return err(e instanceof Error ? e.message : '批量删除失败')
    }
  })

  ipcMain.handle('cs:growth:uploadLocal', async () => {
    try {
      const res = await importLocalMaterials()
      return res.ok ? ok({ added: res.added, contentId: res.contentId, skipped: res.skipped }) : err(res.error ?? '导入失败')
    } catch (e) {
      return err(e instanceof Error ? e.message : '导入失败')
    }
  })

  ipcMain.handle('cs:growth:exportPackage', async (_e, id: unknown, outputIds: unknown) => {
    const cid = clampInt(id, 0, 1, Number.MAX_SAFE_INTEGER)
    if (!cid) return err('非法素材 ID')
    const outs = Array.isArray(outputIds) ? outputIds.map((v) => clampInt(v, 0, 1, Number.MAX_SAFE_INTEGER)).filter(Boolean) : []
    try {
      const res = await exportPublishPackage(cid, outs)
      return res.ok ? ok({ dir: res.dir, files: res.files }) : err(res.error ?? '导出失败')
    } catch (e) {
      return err(e instanceof Error ? e.message : '导出失败')
    }
  })

  ipcMain.handle('cs:growth:redownloadMedia', async (_e, id: unknown) => {
    const cid = clampInt(id, 0, 1, Number.MAX_SAFE_INTEGER)
    if (!cid) return err('非法素材 ID')
    try {
      const res = await redownloadMissingMedia(cid)
      return res.ok ? ok({ added: res.added, failed: res.failed }) : err(res.error ?? '重新下载失败')
    } catch (e) {
      return err(e instanceof Error ? e.message : '重新下载失败')
    }
  })

  ipcMain.handle('cs:growth:overview', () => {
    try {
      return ok({ overview: growthOverview() })
    } catch (e) {
      return err(e instanceof Error ? e.message : '读取概览失败')
    }
  })

  ipcMain.handle('cs:growth:configSet', (_e, field: unknown, value: unknown) => {
    if (field !== 'autoEnabled' && field !== 'provider' && field !== 'providerApiKey') {
      return err('非法配置项')
    }
    const v = typeof value === 'string' ? value : String(value ?? '')
    setGrowthConfigField(field as 'autoEnabled' | 'provider' | 'providerApiKey', v)
    return ok({})
  })
}
