import { clipboard, dialog, ipcMain, nativeImage } from 'electron'
import {
  ingestShareText,
  queryContentDetail,
  queryContents,
  patchContent
} from '../services/growth/warehouse/service'
import { growthStats } from '../db/repos/growthOpsRepo'
import { deleteContent } from '../db/repos/growthRepo'
import { importLocalMaterials } from '../services/growth/collector/localImport'
import { exportPublishPackage } from '../services/growth/publisher/exporter'
import { parsePublishMetrics } from '../services/growth/publisher/publishMetrics'
import { recordPublish } from '../services/growth/remix/service'
import { redownloadMissingMedia } from '../services/growth/collector/media/redownload'
import { listMetricViews, listRemixOutputViews } from '../db/repos/growthOpsRepo'
import { batchDeleteContents, batchPatchContents } from '../db/repos/growthRepo'
import { growthOverview } from '../db/repos/growthOpsRepo'
import { existsSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { getGrowthMediaDir } from '../services/paths'
import { clampInt } from './_util'

/**
 * 营销增长(growth)IPC: cs:growth:*。
 * 与既有域保持一致: 参数在入口处做基本校验, 错误统一回 { ok:false, error }。
 */

function err<T = never>(error: string): { ok: false; error: string } & T {
  return { ok: false, error } as { ok: false; error: string } & T
}

function ok<T>(value: T): { ok: true } & T {
  return { ok: true, ...value }
}

export function registerGrowthHandlers(): void {
  ipcMain.handle('cs:growth:stats', () => ok({ stats: growthStats() }))

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
    const list = Array.isArray(ids)
      ? ids.map((v) => clampInt(v, 0, 1, Number.MAX_SAFE_INTEGER)).filter(Boolean)
      : []
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
    const list = Array.isArray(ids)
      ? ids.map((v) => clampInt(v, 0, 1, Number.MAX_SAFE_INTEGER)).filter(Boolean)
      : []
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
      return res.ok
        ? ok({ added: res.added, contentId: res.contentId, skipped: res.skipped })
        : err(res.error ?? '导入失败')
    } catch (e) {
      return err(e instanceof Error ? e.message : '导入失败')
    }
  })

  /**
   * 登记发布与效果回填。
   *
   * 为什么必须有这个入口：在此之前**只有 AI 对话工具**能写 growth_metric_snapshot，
   * 而看板空态却指引用户「在素材详情里点登记发布」—— 那个按钮根本不存在（DashboardPage:609）。
   * 结果是营销漏斗永远没有数据。校验规则见 publishMetrics.parsePublishMetrics（纯函数，有自检）。
   */
  ipcMain.handle(
    'cs:growth:recordPublish',
    async (_e, id: unknown, input: Record<string, unknown>) => {
      const cid = clampInt(id, 0, 1, Number.MAX_SAFE_INTEGER)
      if (!cid) return err('非法素材 ID')
      const parsed = parsePublishMetrics(input ?? {})
      if (!parsed.ok) return err(parsed.error)
      try {
        const r = recordPublish(cid, parsed.value)
        return ok({ score: r.score, metric: r.metric })
      } catch (e) {
        return err(e instanceof Error ? e.message : '登记失败')
      }
    }
  )

  ipcMain.handle('cs:growth:exportPackage', async (_e, id: unknown, outputIds: unknown) => {
    const cid = clampInt(id, 0, 1, Number.MAX_SAFE_INTEGER)
    if (!cid) return err('非法素材 ID')
    const outs = Array.isArray(outputIds)
      ? outputIds.map((v) => clampInt(v, 0, 1, Number.MAX_SAFE_INTEGER)).filter(Boolean)
      : []
    try {
      const res = await exportPublishPackage(cid, outs)
      return res.ok ? ok({ dir: res.dir, files: res.files }) : err(res.error ?? '导出失败')
    } catch (e) {
      return err(e instanceof Error ? e.message : '导出失败')
    }
  })

  /**
   * 批量导出发布包：**先弹一次目录**，再对每条素材复用同一个父目录（各自建「标题-id」子目录）。
   * 逐条导出而不合成一个大包，是为了保留现有的目录结构（图片/文案/视频分开），
   * 也避免一条素材出错就把整批拖失败 —— 返回里带上失败的素材，前端给一句汇总。
   */
  ipcMain.handle('cs:growth:exportPackageBatch', async (_e, ids: unknown) => {
    const list = Array.isArray(ids)
      ? ids.map((v) => clampInt(v, 0, 1, Number.MAX_SAFE_INTEGER)).filter(Boolean)
      : []
    if (list.length === 0) return err('请先勾选要导出的素材')
    try {
      const picked = await dialog.showOpenDialog({
        title: '选择发布包导出目录（每条素材一个子目录）',
        properties: ['openDirectory', 'createDirectory']
      })
      if (picked.canceled || !picked.filePaths[0]) return err('已取消导出')
      const parent = picked.filePaths[0]
      let exported = 0
      let files = 0
      const failed: string[] = []
      for (const cid of list) {
        const res = await exportPublishPackage(cid, [], parent)
        if (res.ok) {
          exported += 1
          files += res.files ?? 0
        } else {
          failed.push(`#${cid}: ${res.error ?? '导出失败'}`)
        }
      }
      if (exported === 0) return err(failed[0] ?? '导出失败')
      return ok({ dir: parent, exported, files, failed })
    } catch (e) {
      return err(e instanceof Error ? e.message : '导出失败')
    }
  })

  ipcMain.handle('cs:growth:redownloadMedia', async (_e, id: unknown) => {
    const cid = clampInt(id, 0, 1, Number.MAX_SAFE_INTEGER)
    if (!cid) return err('非法素材 ID')
    try {
      const res = await redownloadMissingMedia(cid)
      return res.ok
        ? ok({ added: res.added, failed: res.failed })
        : err(res.error ?? '重新下载失败')
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
}
