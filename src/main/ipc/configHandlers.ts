import { ipcMain } from 'electron'
import { getAllConfig, setConfig } from '../db/repos/config'
import {
  getCachePath,
  getDefaultCachePath,
  invalidateCachePathCache,
  isDefaultCachePath
} from '../services/paths'
import { openSecret, sealSecret } from '../services/secrets'
import { isSecretConfigKey } from '../services/securityPolicy'

/**
 * 全局配置 IPC（设置页用）。
 * 键空间见各服务：ai.baseUrl/ai.apiKey/ai.model/ai.enabled、
 * send.dailyLimit/send.humanizeDelay/send.halted、inject.enabled、cache.path。
 * ai.apiKey 为敏感值：落库前 safeStorage 加封（enc1:），回读时开封为明文供表单回显。
 */
export function registerConfigHandlers(): void {
  /**
   * 敏感配置键(落库前 safeStorage 加封, 回读时开封)。
   * 除了固定名单，还要认**带账号后缀**的键（img:<wxid>:xorKey/aesKey）—— 它们键名不固定，
   * 以前只按名单判断，导致图片解密密钥一直是明文落库（见 securityPolicy.isSecretConfigKey）。
   */
  const SECRET_KEYS = (key: string): boolean => isSecretConfigKey(key)

  ipcMain.handle('cs:config:getAll', () => {
    const all = getAllConfig()
    for (const key of Object.keys(all)) {
      if (SECRET_KEYS(key)) all[key] = openSecret(all[key])
    }
    return all
  })

  ipcMain.handle('cs:config:set', (_e, key: string, value: string) => {
    if (typeof key !== 'string' || key.length === 0 || key.length > 64) {
      return { ok: false, error: '非法配置键' }
    }
    setConfig(key, SECRET_KEYS(key) ? sealSecret(String(value ?? '')) : String(value ?? ''))
    // 缓存目录/能力开关等被缓存过的派生值需要失效
    if (key === 'cache.path') invalidateCachePathCache()
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
