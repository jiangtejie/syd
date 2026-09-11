import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'fs'
import { getConfig } from '../db/repos/config'

/**
 * 应用数据路径管理。
 *
 * 缓存目录规范结构（所有写缓存的代码只应通过本模块取目录，禁止硬编码子目录名）：
 *   <cacheRoot>/
 *   ├─ db/      解密后的微信明文库副本（源库路径 + key 相同则复用同名文件，每次打开会重新解密覆盖）
 *   ├─ media/   附件解码产物缓存（解密图片 / 视频），内部按 <wxid>/ 分账号存放
 *   │   └─ <wxid>/<md5>_<kind>.<ext>、<md5>_video.<ext>
 *   ├─ files/   渠道接收文件(飞书等外部 IM 下载的图片/文件),按 acct-<账号>/user-<发送人>/日期 归档
 *   ├─ tmp/     一次性临时文件（转码中间产物等，随时可清，重启可删）
 *   └─ export/  用户主动导出的产物（随「清理缓存」一并清除，用于导出附件/报表等）
 *
 * 命名约定：历史版本明文库目录名为 wx-plain，启动时自动迁移并入 db（见 migrateLegacyCacheLayout）。
 * 本地数据库 cs.db 固定存 userData，不随缓存目录配置迁移。
 *
 * 默认缓存目录策略（Windows）：优先取非系统盘（D/E/F...）下的应用目录，
 * 避免占系统盘空间；无可用非系统盘或创建失败时回退 userData/cache。
 */

const CONFIG_KEY = 'cache.path'
const APP_DIR_NAME = 'wechat-cs-desktop'
/** 历史版本明文库目录名（现已并入 db 分区） */
const LEGACY_PLAIN_DIR = 'wx-plain'

/** 缓存目录顶层分区（新增用途前先在此登记，保证结构统一） */
export const CACHE_SUB_DIRS = ['db', 'media', 'files', 'tmp', 'export', 'growth'] as const
export type CacheSubDir = (typeof CACHE_SUB_DIRS)[number]

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

/**
 * 生效的缓存目录：读配置（空则默认），并确保目录存在。
 * 结果缓存：媒体协议、文件接收、日志路径等高频调用链都会走到这里，
 * 每次一条 SQL + existsSync 是纯开销；配置变更时由 invalidateCachePathCache 失效。
 */
let cachedEffectivePath: string | null = null

/** 配置变更（cs:config:set cache.path）后调用 */
export function invalidateCachePathCache(): void {
  cachedEffectivePath = null
}

export function getCachePath(): string {
  if (cachedEffectivePath) return cachedEffectivePath
  const configured = getConfig(CONFIG_KEY)?.trim()
  const dir = configured || getDefaultCachePath()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  cachedEffectivePath = dir
  return dir
}

export function isDefaultCachePath(): boolean {
  return !getConfig(CONFIG_KEY)?.trim()
}

/** 缓存分区目录：<cache>/<sub>（不存在则创建，供 db/tmp/export 及需要确保根存在的场景使用） */
export function getCacheSubPath(sub: CacheSubDir): string {
  const dir = join(getCachePath(), sub)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** 解密后的微信明文库副本目录：<cache>/db */
export function getPlainDbDir(): string {
  return getCacheSubPath('db')
}

/** 媒体解码产物根目录：<cache>/media（ct-media 协议映射根） */
export function getMediaRootDir(): string {
  return getCacheSubPath('media')
}

/** 某账号媒体缓存目录路径：<cache>/media/<wxid>（纯路径拼接，读取方自行容错；写入方需 mkdir） */
export function getMediaCacheDir(wxid: string): string {
  return join(getCachePath(), 'media', wxid)
}

/**
 * 上报媒体的归档目录：<cache>/media/<wxid>/archive。
 * 与「可再生的展示缓存」分开，是因为 PG 的 media_path 指着归档文件 —— 缓存可以按策略淘汰，归档不能。
 * 注意：ct-media 协议按段解析且子目录白名单里没有 archive，归档不会被协议暴露出去（见 mediaProtocol）。
 */
export function getMediaArchiveDir(wxid: string): string {
  return join(getCachePath(), 'media', wxid, 'archive')
}

/** 语音解码产物目录：<cache>/media/<wxid>/voices（淘汰策略见 media/voice.ts） */
export function getVoiceCacheDir(wxid: string): string {
  return join(getCachePath(), 'media', wxid, 'voices')
}

/** 渠道接收文件根目录：<cache>/files */
export function getFilesRootDir(): string {
  return getCacheSubPath('files')
}

/** 一次性临时文件目录：<cache>/tmp */
export function getTmpDir(): string {
  return getCacheSubPath('tmp')
}

/** 用户导出产物目录：<cache>/export */
export function getExportDir(): string {
  return getCacheSubPath('export')
}

/**
 * 历史缓存布局迁移：wx-plain → db。
 * 明文副本由「源库路径 + key」即时再生，可直接并入；
 * 目标已存在时旧目录整体删除避免残留双份敏感明文。失败静默，下次启动重试。
 */
/** 营销增长(growth)素材根目录:<cache>/growth */
export function getGrowthRootDir(): string {
  return getCacheSubPath('growth')
}

/** 营销增长(growth)已下载媒体(封面/图集)目录:<cache>/growth/media */
export function getGrowthMediaDir(): string {
  return join(getCacheSubPath('growth'), 'media')
}

export function migrateLegacyCacheLayout(): void {
  const root = getCachePath()
  const legacy = join(root, LEGACY_PLAIN_DIR)
  if (!existsSync(legacy)) return
  try {
    const dbDir = join(root, 'db')
    if (!existsSync(dbDir)) {
      renameSync(legacy, dbDir)
    } else {
      rmSync(legacy, { recursive: true, force: true })
    }
  } catch {
    /* 迁移失败（目录被占用/只读等），保留现状待下次启动重试 */
  }
}
