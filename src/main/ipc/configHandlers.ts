import { ipcMain } from 'electron'
import { getAllConfig, setConfig } from '../db/repos/config'
import { getCachePath, getDefaultCachePath, isDefaultCachePath } from '../services/paths'

/**
 * 全局配置 IPC（设置页用）。
 * 键空间见各服务：ai.baseUrl/ai.apiKey/ai.model/ai.enabled、
 * send.dailyLimit/send.humanizeDelay/send.halted、inject.enabled、cache.path。
 */
export function registerConfigHandlers(): void {
  ipcMain.handle('cs:config:getAll', () => getAllConfig())

  ipcMain.handle('cs:config:set', (_e, key: string, value: string) => {
    if (typeof key !== 'string' || key.length === 0 || key.length > 64) {
      return { ok: false, error: '非法配置键' }
    }
    setConfig(key, String(value ?? ''))
    return { ok: true }
  })

  // 缓存目录生效值（含默认回退 + 自动建目录）
  ipcMain.handle('cs:config:cachePath', () => ({
    ok: true,
    path: getCachePath(),
    defaultPath: getDefaultCachePath(),
    isDefault: isDefaultCachePath()
  }))
}
