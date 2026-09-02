import { ipcMain, app } from 'electron'
import { join } from 'path'
import { statSync, readdirSync, rmSync, mkdirSync } from 'fs'
import { getCachePath } from '../services/paths'

/**
 * 应用级 IPC（产品通用能力）：
 * - cs:app:info          版本/运行环境信息
 * - cs:app:getAutoLaunch / setAutoLaunch   开机自启
 * - cs:app:dataStats     本地数据库与缓存占用
 * - cs:app:clearCache    清理缓存目录（保留数据库）
 */

function dirSize(dir: string): number {
  let total = 0
  try {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name)
      try {
        if (name.isDirectory()) total += dirSize(p)
        else total += statSync(p).size
      } catch {
        /* 单个文件失败跳过 */
      }
    }
  } catch {
    /* 目录不存在按 0 */
  }
  return total
}

/** 本地库总大小（cs.db 主文件 + WAL/SHM） */
function dbSize(): number {
  let total = 0
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      total += statSync(join(app.getPath('userData'), `cs.db${suffix}`)).size
    } catch {
      /* 文件不存在跳过 */
    }
  }
  return total
}

export function registerAppHandlers(): void {
  ipcMain.handle('cs:app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform
  }))

  ipcMain.handle('cs:app:getAutoLaunch', () => ({
    ok: true,
    enabled: app.getLoginItemSettings().openAtLogin
  }))

  ipcMain.handle('cs:app:setAutoLaunch', (_e, enabled: boolean) => {
    app.setLoginItemSettings({ openAtLogin: !!enabled })
    return { ok: true, enabled: app.getLoginItemSettings().openAtLogin }
  })

  ipcMain.handle('cs:app:dataStats', () => ({
    ok: true,
    dbBytes: dbSize(),
    cacheBytes: dirSize(getCachePath()),
    cachePath: getCachePath()
  }))

  ipcMain.handle('cs:app:clearCache', () => {
    const dir = getCachePath()
    try {
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : '清理失败' }
    }
  })
}
