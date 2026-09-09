/**
 * 舆情监控 IPC: cs:growthbuzz:*
 * 概览 / 列表 / 详情 / 链接入库 / 评论录入 / 诊断 / 状态更新 / 删除。
 */

import { shell, ipcMain } from 'electron'
import { createLogger } from '../services/logging'
import {
  addBuzzComments,
  addBuzzLink,
  deleteBuzz,
  deleteBuzzComment,
  diagnoseBuzz,
  diagnoseBuzzBatch,
  patchBuzz,
  queryBuzzDetail,
  queryBuzzList,
  queryBuzzOverview,
  sendBuzzToWorkbench
} from '../services/growth/buzz/service'
import { clampInt } from './_util'

const buzzLog = createLogger('growth-buzz')

function str(v: unknown, max = 4000): string {
  return typeof v === 'string' ? v.slice(0, max) : ''
}

function ok<T>(value: T): { ok: true } & T {
  return { ok: true, ...value }
}

function err(error: string): { ok: false; error: string } {
  return { ok: false, error }
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function registerGrowthBuzzHandlers(): void {
  ipcMain.handle('cs:growthbuzz:overview', (_e, storeId: unknown) => {
    try {
      const sid = clampInt(storeId, 0, 0, Number.MAX_SAFE_INTEGER)
      return ok({ overview: queryBuzzOverview(sid > 0 ? sid : null) })
    } catch (e) {
      return err(reason(e))
    }
  })

  ipcMain.handle('cs:growthbuzz:list', (_e, filter: unknown) => {
    try {
      const f = (filter ?? {}) as Record<string, unknown>
      const storeId = clampInt(f['storeId'], 0, 0, Number.MAX_SAFE_INTEGER)
      const res = queryBuzzList({
        storeId: storeId > 0 ? storeId : null,
        platform: str(f['platform'], 20),
        sentiment: str(f['sentiment'], 20),
        status: str(f['status'], 20),
        keyword: str(f['keyword'], 100),
        limit: clampInt(f['limit'], 100, 1, 500),
        offset: clampInt(f['offset'], 0, 0, 100000)
      })
      return ok(res)
    } catch (e) {
      return err(reason(e))
    }
  })

  ipcMain.handle('cs:growthbuzz:detail', (_e, id: unknown) => {
    const mentionId = clampInt(id, 0, 1, Number.MAX_SAFE_INTEGER)
    if (!mentionId) return err('非法舆情 ID')
    try {
      const detail = queryBuzzDetail(mentionId)
      if (!detail) return err('舆情记录不存在')
      return ok(detail)
    } catch (e) {
      return err(reason(e))
    }
  })

  ipcMain.handle('cs:growthbuzz:addLink', async (_e, input: unknown) => {
    const i = (input ?? {}) as Record<string, unknown>
    const storeId = clampInt(i['storeId'], 0, 0, Number.MAX_SAFE_INTEGER)
    const text = str(i['text'], 2000).trim()
    if (!text) return err('请粘贴抖音/小红书链接或分享口令')
    buzzLog.info('addLink store=' + String(storeId) + ' text=' + text.slice(0, 120))
    try {
      const res = await addBuzzLink({ storeId: storeId > 0 ? storeId : null, text })
      if (!res.ok) return err(res.error || '入库失败')
      return ok(res)
    } catch (e) {
      buzzLog.warn('addLink failed: ' + reason(e))
      return err(reason(e))
    }
  })

  ipcMain.handle('cs:growthbuzz:addComments', async (_e, input: unknown) => {
    const i = (input ?? {}) as Record<string, unknown>
    const mentionId = clampInt(i['mentionId'], 0, 1, Number.MAX_SAFE_INTEGER)
    if (!mentionId) return err('非法舆情 ID')
    const raw = str(i['raw'], 20000)
    if (!raw.trim()) return err('请粘贴评论区内容')
    try {
      const res = await addBuzzComments({
        mentionId,
        raw,
        source: str(i['source'], 20) || 'manual'
      })
      if (!res.ok) return err(res.error || '评论录入失败')
      return ok(res)
    } catch (e) {
      buzzLog.warn('addComments failed: ' + reason(e))
      return err(reason(e))
    }
  })

  ipcMain.handle('cs:growthbuzz:diagnose', async (_e, id: unknown, useModel: unknown) => {
    const mentionId = clampInt(id, 0, 1, Number.MAX_SAFE_INTEGER)
    if (!mentionId) return err('非法舆情 ID')
    try {
      const diagnosis = await diagnoseBuzz(mentionId, useModel !== false)
      return ok({ diagnosis, mention: queryBuzzDetail(mentionId)?.mention })
    } catch (e) {
      buzzLog.warn('diagnose failed id=' + String(mentionId) + ' ' + reason(e))
      return err(reason(e))
    }
  })

  ipcMain.handle('cs:growthbuzz:diagnoseBatch', async (_e, ids: unknown, useModel: unknown) => {
    const list = Array.isArray(ids)
      ? ids.map((x) => clampInt(x, 0, 0, Number.MAX_SAFE_INTEGER)).filter((x) => x > 0)
      : []
    if (list.length === 0) return err('请选择要诊断的记录')
    try {
      const res = await diagnoseBuzzBatch(list, useModel !== false)
      return ok({ succeeded: res.ok, failed: res.failed })
    } catch (e) {
      return err(reason(e))
    }
  })

  ipcMain.handle('cs:growthbuzz:update', (_e, id: unknown, patch: unknown) => {
    const mentionId = clampInt(id, 0, 1, Number.MAX_SAFE_INTEGER)
    if (!mentionId) return err('非法舆情 ID')
    const p = (patch ?? {}) as Record<string, unknown>
    const clean: {
      storeId?: number | null
      status?: string
      note?: string
      sentiment?: string
      score?: number
    } = {}
    if (p['storeId'] !== undefined) {
      const sid = clampInt(p['storeId'], 0, 0, Number.MAX_SAFE_INTEGER)
      clean.storeId = sid > 0 ? sid : null
    }
    if (typeof p['status'] === 'string' && p['status']) clean.status = p['status']
    if (typeof p['note'] === 'string') clean.note = p['note'].slice(0, 1000)
    if (typeof p['sentiment'] === 'string') clean.sentiment = p['sentiment']
    if (p['score'] !== undefined) clean.score = clampInt(p['score'], 0, -100, 100)
    try {
      const done = patchBuzz(mentionId, clean)
      if (!done) return err('舆情记录不存在')
      return ok({ mention: queryBuzzDetail(mentionId)?.mention })
    } catch (e) {
      return err(reason(e))
    }
  })

  ipcMain.handle('cs:growthbuzz:remove', (_e, id: unknown) => {
    const mentionId = clampInt(id, 0, 1, Number.MAX_SAFE_INTEGER)
    if (!mentionId) return err('非法舆情 ID')
    try {
      const done = deleteBuzz(mentionId)
      if (!done) return err('舆情记录不存在')
      return ok({ id: mentionId })
    } catch (e) {
      return err(reason(e))
    }
  })

  ipcMain.handle('cs:growthbuzz:removeComment', (_e, id: unknown) => {
    const commentId = clampInt(id, 0, 1, Number.MAX_SAFE_INTEGER)
    if (!commentId) return err('非法评论 ID')
    try {
      deleteBuzzComment(commentId)
      return ok({ id: commentId })
    } catch (e) {
      return err(reason(e))
    }
  })

  ipcMain.handle('cs:growthbuzz:openUrl', async (_e, url: unknown) => {
    const target = str(url, 2000).trim()
    if (!/^https?:\/\//i.test(target)) return err('链接不合法')
    try {
      await shell.openExternal(target)
      return ok({ url: target })
    } catch (e) {
      return err(reason(e))
    }
  })

  ipcMain.handle('cs:growthbuzz:toWorkbench', async (_e, id: unknown) => {
    const mentionId = clampInt(id, 0, 1, Number.MAX_SAFE_INTEGER)
    if (!mentionId) return err('非法舆情 ID')
    try {
      const res = await sendBuzzToWorkbench(mentionId)
      if (!res.ok) return err(res.error || '创建任务失败')
      return ok(res)
    } catch (e) {
      buzzLog.warn('toWorkbench failed id=' + String(mentionId) + ' ' + reason(e))
      return err(reason(e))
    }
  })
}
