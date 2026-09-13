/**
 * 营销 AI 工作台 IPC: cs:growthai:*
 * 任务/对话/候选/产出 + 门店档案 + 生图与搜索配置。
 */

import { BrowserWindow, dialog, ipcMain } from 'electron'
import { createLogger } from '../services/logging'
import { listChatMessages } from '../db/repos/chatRepo'
import {
  getTask,
  getBrandProfile,
  listStores,
  listTasks,
  removeStore,
  saveBrandProfile,
  saveStore,
  updateTask,
  type GrowthStoreInput
} from '../db/repos/growthAiRepo'
import {
  createTaskFromContent,
  deleteTask,
  getTaskBundle,
  resolveCandidate,
  revertOutput
} from '../services/growth/ai/taskService'
import {
  isGrowthRunning,
  sendGrowthMessage,
  stopGrowthChat
} from '../services/growth/ai/growthEngine'
import {
  getImageConfig,
  getSearchConfig,
  setGrowthAiConfigField,
  type GrowthAiConfigField
} from '../services/growth/ai/config'
import { testImageChannel } from '../services/growth/ai/imageProvider'
import { queryContents } from '../services/growth/warehouse/service'
import { clampInt } from './_util'

function ok<T>(value: T): { ok: true } & T {
  return { ok: true, ...value }
}

function err(error: string): { ok: false; error: string } {
  return { ok: false, error }
}

const aiLog = createLogger('growth-ai')

export function registerGrowthAiHandlers(): void {
  // ── 任务 ──
  ipcMain.handle('cs:growthai:listTasks', () => {
    try {
      // 带上运行态：营销页是多任务并行（一个素材一个任务），左栏得能看出"别的任务正在跑"
      const tasks = listTasks().map((t) => ({ ...t, running: isGrowthRunning(t.id) }))
      return ok({ tasks })
    } catch (e) {
      return err(e instanceof Error ? e.message : '读取任务失败')
    }
  })

  ipcMain.handle('cs:growthai:getTask', (_e, id: unknown) => {
    const taskId = clampInt(id, 0, 1, Number.MAX_SAFE_INTEGER)
    if (!taskId) return err('非法任务 ID')
    const bundle = getTaskBundle(taskId)
    return bundle ? ok(bundle) : err('任务不存在')
  })

  ipcMain.handle('cs:growthai:createTask', async (_e, input: unknown) => {
    const raw = (input ?? {}) as Record<string, unknown>
    const contentId = clampInt(raw.contentId, 0, 1, Number.MAX_SAFE_INTEGER)
    if (!contentId) return err('非法素材 ID')
    const storeId =
      raw.storeId === null || raw.storeId === undefined
        ? null
        : clampInt(raw.storeId, 0, 0, Number.MAX_SAFE_INTEGER) || null
    const goal = typeof raw.goal === 'string' ? raw.goal.slice(0, 32) : 'image_text'
    const res = await createTaskFromContent({ contentId, storeId, goal })
    return res.ok
      ? ok({ taskId: res.taskId, sessionId: res.sessionId })
      : err(res.error ?? '创建任务失败')
  })

  ipcMain.handle('cs:growthai:updateTask', (_e, id: unknown, patch: unknown) => {
    const taskId = clampInt(id, 0, 1, Number.MAX_SAFE_INTEGER)
    if (!taskId) return err('非法任务 ID')
    const p = (patch ?? {}) as Record<string, unknown>
    const clean: Record<string, string | number | null> = {}
    for (const k of ['title', 'goal', 'status', 'stage', 'summary'] as const) {
      if (typeof p[k] === 'string') clean[k] = (p[k] as string).slice(0, 200)
    }
    if (p.storeId === null) clean.storeId = null
    else if (p.storeId !== undefined)
      clean.storeId = clampInt(p.storeId, 0, 0, Number.MAX_SAFE_INTEGER) || null
    try {
      updateTask(taskId, clean as never)
      return ok({})
    } catch (e) {
      return err(e instanceof Error ? e.message : '更新失败')
    }
  })

  ipcMain.handle('cs:growthai:deleteTask', async (e, id: unknown) => {
    const taskId = clampInt(id, 0, 1, Number.MAX_SAFE_INTEGER)
    if (!taskId) return err('非法任务 ID')
    aiLog.info('deleteTask requested id=' + String(taskId))
    const task = getTask(taskId)
    if (!task) return err('任务不存在(可能已删除)')
    // 原生确认框(渲染层弹窗可能被遮挡/失效, 这里用系统对话框保证可见)
    const opts = {
      type: 'warning' as const,
      buttons: ['删除', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: '删除爆改任务',
      message: '删除任务「' + (task.title || task.contentTitle || '未命名') + '」?',
      detail: '该任务的对话记录会一并删除; 素材本身保留在素材仓库。'
    }
    const win = BrowserWindow.fromWebContents(e.sender)
    const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
    if (r.response !== 0) {
      aiLog.info('deleteTask cancelled id=' + String(taskId))
      return err('已取消删除')
    }
    const res = deleteTask(taskId)
    return res.ok ? ok({}) : err(res.error ?? '删除失败')
  })

  // ── 对话 ──
  ipcMain.handle('cs:growthai:messages', (_e, id: unknown) => {
    const taskId = clampInt(id, 0, 1, Number.MAX_SAFE_INTEGER)
    const task = taskId ? getTask(taskId) : null
    if (!task?.sessionId) return err('任务会话不存在')
    return ok({ messages: listChatMessages(task.sessionId) })
  })

  ipcMain.handle(
    'cs:growthai:sendMessage',
    async (_e, id: unknown, text: unknown, images: unknown) => {
      const taskId = clampInt(id, 0, 1, Number.MAX_SAFE_INTEGER)
      if (!taskId) return err('非法任务 ID')
      const msg = typeof text === 'string' ? text.slice(0, 8000) : ''
      const imgs = Array.isArray(images)
        ? images.filter((x): x is string => typeof x === 'string').slice(0, 3)
        : []
      const res = await sendGrowthMessage(taskId, msg, imgs)
      return res.ok ? ok({}) : err(res.error ?? '发送失败')
    }
  )

  ipcMain.handle('cs:growthai:stop', (_e, id: unknown) => {
    const taskId = clampInt(id, 0, 1, Number.MAX_SAFE_INTEGER)
    if (!taskId) return err('非法任务 ID')
    stopGrowthChat(taskId)
    return ok({})
  })

  ipcMain.handle('cs:growthai:running', (_e, id: unknown) => {
    const taskId = clampInt(id, 0, 1, Number.MAX_SAFE_INTEGER)
    return ok({ running: taskId ? isGrowthRunning(taskId) : false })
  })

  // ── 候选 / 产出 ──
  ipcMain.handle(
    'cs:growthai:resolveCandidate',
    (_e, id: unknown, outputId: unknown, action: unknown) => {
      const taskId = clampInt(id, 0, 1, Number.MAX_SAFE_INTEGER)
      const oid = clampInt(outputId, 0, 1, Number.MAX_SAFE_INTEGER)
      const act = action === 'archive' || action === 'delete' ? action : 'select'
      if (!taskId || !oid) return err('参数不合法')
      const res = resolveCandidate(taskId, oid, act)
      return res.ok ? ok({}) : err(res.error ?? '操作失败')
    }
  )

  ipcMain.handle('cs:growthai:revertOutput', (_e, outputId: unknown) => {
    const oid = clampInt(outputId, 0, 1, Number.MAX_SAFE_INTEGER)
    if (!oid) return err('非法产出 ID')
    revertOutput(oid)
    return ok({})
  })

  // ── 门店与品牌档案 ──
  ipcMain.handle('cs:growthai:listStores', () => ok({ stores: listStores() }))

  ipcMain.handle('cs:growthai:saveStore', (_e, input: unknown) => {
    const raw = (input ?? {}) as Record<string, unknown>
    const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 80) : ''
    if (!name) return err('门店名称不能为空')
    const s = (k: string, n = 200): string =>
      typeof raw[k] === 'string' ? (raw[k] as string).trim().slice(0, n) : ''
    const payload: GrowthStoreInput = {
      id:
        raw.id === undefined
          ? undefined
          : clampInt(raw.id, 0, 0, Number.MAX_SAFE_INTEGER) || undefined,
      brandName: s('brandName', 80),
      name,
      city: s('city', 40),
      address: s('address', 200),
      bizType: s('bizType', 40),
      poi: typeof raw.poi === 'string' ? raw.poi.slice(0, 2000) : '[]',
      profile: typeof raw.profile === 'string' ? raw.profile.slice(0, 8000) : '{}',
      enabled: raw.enabled !== false
    }
    try {
      const id = saveStore(payload)
      return ok({ id })
    } catch (e) {
      return err(e instanceof Error ? e.message : '保存失败')
    }
  })

  ipcMain.handle('cs:growthai:removeStore', (_e, id: unknown) => {
    const sid = clampInt(id, 0, 1, Number.MAX_SAFE_INTEGER)
    if (!sid) return err('非法门店 ID')
    removeStore(sid)
    return ok({})
  })

  ipcMain.handle('cs:growthai:getBrand', () => ok({ brand: getBrandProfile() }))

  ipcMain.handle('cs:growthai:saveBrand', (_e, name: unknown, profile: unknown) => {
    const n = typeof name === 'string' ? name.slice(0, 80) : ''
    const p = typeof profile === 'string' ? profile.slice(0, 8000) : '{}'
    const id = saveBrandProfile(n, p)
    return ok({ id })
  })

  // ── 生图 / 搜索配置 ──
  ipcMain.handle('cs:growthai:configGet', () => {
    const img = getImageConfig()
    const sea = getSearchConfig()
    return ok({
      image: {
        enabled: img.enabled,
        baseUrl: img.baseUrl,
        apiKey: img.apiKey,
        model: img.model,
        size: img.size,
        count: img.count,
        monthlyBudget: img.monthlyBudget
      },
      search: { enabled: sea.enabled, provider: sea.provider, apiKey: sea.apiKey }
    })
  })

  ipcMain.handle('cs:growthai:configSet', (_e, field: unknown, value: unknown) => {
    const allowed: GrowthAiConfigField[] = [
      'imageEnabled',
      'imageBaseUrl',
      'imageApiKey',
      'imageModel',
      'imageSize',
      'imageCount',
      'imageBudget',
      'searchEnabled',
      'searchProvider',
      'searchApiKey'
    ]
    const f = String(field ?? '') as GrowthAiConfigField
    if (!allowed.includes(f)) return err('非法配置项')
    setGrowthAiConfigField(f, typeof value === 'string' ? value : String(value ?? ''))
    return ok({})
  })

  ipcMain.handle('cs:growthai:testImage', async () => {
    const cfg = getImageConfig()
    if (!cfg.enabled || !cfg.baseUrl || !cfg.apiKey) return err('请先填写并开启生图配置')
    const first = queryContents({ limit: 1, offset: 0 }).items[0]
    if (!first) return err('请先在素材仓库入库一条素材, 再测试生图(生成图会挂到该素材下)')
    const res = await testImageChannel(first.id)
    return res.ok ? ok({}) : err(res.error ?? '生图测试失败')
  })
}
