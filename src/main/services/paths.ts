import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readdirSync } from 'fs'
import { getConfig } from '../db/repos/config'

/**
 * 应用数据路径管理。
 * 缓存目录用于：解密图片/附件缓存、导出文件等（媒体解密与导出接入后使用）。
 * 本地数据库 cs.db 固定存 userData，不随缓存目录配置迁移。
 *
 * 默认缓存目录策略（Windows）：优先取非系统盘（D/E/F...）下的应用目录，
 * 避免占系统盘空间；无可用非系统盘或创建失败时回退 userData/cache。
 */

const CONFIG_KEY = 'cache.path'
const APP_DIR_NAME = 'wechat-cs-desktop'

/** 探测第一个可用的非系统盘根目录（如 D:\），不可用返回 null */
function pickNonSystemDriveRoot(): string | null {
  if (process.platform !== 'win32') return null
  const systemDrive = (process.env.SystemDrive || 'C:').toUpperCase()
  for (const code of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
    const drive = `${code}:`
    if (drive === systemDrive) continue
    const root = `${drive}\\`
    try {
      // existsSync 对无盘的光驱/读卡器可能误判，readdir 验证真实可访问
      if (existsSync(root)) {
        readdirSync(root)
        return root
      }
    } catch {
      /* 该盘不可用，继续探测下一个 */
    }
  }
  return null
}

let cachedDefaultPath: string | null = null

export function getDefaultCachePath(): string {
  if (cachedDefaultPath) return cachedDefaultPath
  const driveRoot = pickNonSystemDriveRoot()
  if (driveRoot) {
    const dir = join(driveRoot, APP_DIR_NAME, 'cache')
    try {
      mkdirSync(dir, { recursive: true })
      cachedDefaultPath = dir
      return dir
    } catch {
      /* 创建失败（权限等）走回退 */
    }
  }
  cachedDefaultPath = join(app.getPath('userData'), 'cache')
  return cachedDefaultPath
}

/** 生效的缓存目录：读配置（空则默认），并确保目录存在 */
export function getCachePath(): string {
  const configured = getConfig(CONFIG_KEY)?.trim()
  const dir = configured || getDefaultCachePath()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function isDefaultCachePath(): boolean {
  return !getConfig(CONFIG_KEY)?.trim()
}
