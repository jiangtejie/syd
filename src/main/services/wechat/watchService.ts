import { BrowserWindow } from 'electron'
import { WeChatDbMonitor, type DbChangeInfo } from './monitor'
import { invalidateWxPathCaches, locateWeChatDbs } from './dbLocator'
import { invalidateOpsCache } from './opsStats'
import * as keyStore from '../keyStoreService'

/**
 * 监控桥服务（T5）：管理监控生命周期，把库变化推送给渲染进程。
 *
 * 通道：主进程 webContents.send('cs:wx:dbChanged', payload)
 * 渲染端通过 preload 暴露的 onDbChanged(callback) 订阅。
 */

const monitors = new Map<string, WeChatDbMonitor>()

/** 新消息提醒钩子（主进程设置：flashFrame + 系统通知） */
let onDbChangedNotify: ((sessionChanged: boolean) => void) | null = null

export function setOnDbChangedNotify(fn: (sessionChanged: boolean) => void): void {
  onDbChangedNotify = fn
}

/** 库变化订阅钩子（后台调度器等主进程模块用）；返回取消函数 */
type DbChangedHook = (payload: DbChangedPayload) => void
const dbChangedHooks = new Set<DbChangedHook>()

export function addDbChangeHook(hook: DbChangedHook): () => void {
  dbChangedHooks.add(hook)
  return () => {
    dbChangedHooks.delete(hook)
  }
}

export interface DbChangedPayload {
  wxid: string
  info: DbChangeInfo
}

function broadcast(payload: DbChangedPayload): void {
  // 消息库有变化时使运营统计缓存失效，下一次查询会重新聚合
  invalidateOpsCache(payload.wxid)
  // 路径定位缓存同步失效：库文件可能被微信重建/新增分片
  invalidateWxPathCaches()
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('cs:wx:dbChanged', payload)
  }
  onDbChangedNotify?.(payload.info.sessionChanged)
  for (const hook of dbChangedHooks) {
    try {
      hook(payload)
    } catch {
      /* 单个钩子异常不影响广播 */
    }
  }
}

/** 为 wxid 启动监控（幂等，重复调用返回现有实例） */
export function startWatch(wxid: string): { ok: boolean; error?: string } {
  const existing = monitors.get(wxid)
  if (existing) return { ok: true }

  const hexKey = keyStore.getDecryptedKey(wxid)
  if (!hexKey) return { ok: false, error: '未配置密钥，请先导入' }
  const profile = keyStore.getKeyStatus(wxid)
  if (!profile.dbPath) return { ok: false, error: '未配置微信数据根路径' }

  const paths = locateWeChatDbs(profile.dbPath, wxid)
  if (!paths.dbStoragePath) return { ok: false, error: '未找到微信数据目录（db_storage）' }

  const monitor = new WeChatDbMonitor(paths.dbStoragePath)
  monitor.start((info) => broadcast({ wxid, info }))
  monitors.set(wxid, monitor)
  return { ok: true }
}

/** 停止全部监控（应用退出时调用） */
export function stopAllWatches(): void {
  for (const monitor of monitors.values()) {
    monitor.stop()
  }
  monitors.clear()
}
