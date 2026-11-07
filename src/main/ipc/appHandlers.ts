import { ipcMain, app, nativeTheme, BrowserWindow } from 'electron'
import { normalizeThemeMode } from '../../shared/theme'
import { join } from 'path'
import { statSync, readdirSync, rmSync, mkdirSync } from 'fs'
import { getCachePath } from '../services/paths'

/**
 * 应用级 IPC（产品通用能力）：
 * - cs:app:info          版本/运行环境信息
 * - cs:app:getAutoLaunch / setAutoLaunch   开机自启
 * - cs:app:dataStats     本地数据库与缓存占用
 * - cs:app:clearCache    清理缓存目录（保留数据库）
 * - cs:app:setTheme      浅色 / 深色 / 跟随系统
 */

/** 主题来源交给 nativeTheme 统管：它同时决定渲染端的 prefers-color-scheme，
 *  以及窗口底色（切主题瞬间不会先闪一下白）。取值与渲染端 ThemeMode 一致。 */
const THEME_BG: Record<string, string> = { light: '#f5f6f7', dark: '#050910' }
/** 原生窗控按钮（最小化/最大化/关闭）的符号色：深色下必须换成浅色，否则看不见 */
const THEME_SYMBOL: Record<string, string> = { light: '#5f6368', dark: '#9fb3c8' }

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

  ipcMain.handle('cs:app:setTheme', (_e, mode: unknown) => {
    const m = normalizeThemeMode(mode)
    nativeTheme.themeSource = m
    const dark = m === 'dark' || (m === 'system' && nativeTheme.shouldUseDarkColors)
    const key = dark ? 'dark' : 'light'
    for (const w of BrowserWindow.getAllWindows()) {
      w.setBackgroundColor(THEME_BG[key])
      try {
        w.setTitleBarOverlay({ color: '#00000000', symbolColor: THEME_SYMBOL[key], height: 36 })
      } catch {
        /* Linux 等不支持 overlay 的平台忽略 */
      }
    }
    return { ok: true, dark }
  })

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
