import { safeStorage } from 'electron'
import { getAllConfig, getConfig, setConfig } from '../db/repos/config'
import { createLogger } from './logging'

const secretsLog = createLogger('app')

/**
 * app_config 中敏感值（如 ai.apiKey）的加密存取。
 * 存储形态：
 *   - 明文：历史数据 / 系统加密不可用时（无前缀）
 *   - 密文：`enc1:<base64>`（Electron safeStorage：Windows DPAPI / macOS Keychain / Linux 钥匙环）
 * 读取端兼容两种形态；渲染层仍以明文收发明文 Key，落盘前由主进程加封。
 * 注意：密文与机器 + 系统账户绑定，换机/重装系统后无法解密（与 key_store 同理）。
 */

const ENC_PREFIX = 'enc1:'

/** 落盘前加封：非空且系统加密可用 → enc1: 形式；否则原样（明文降级） */
export function sealSecret(plain: string): string {
  if (!plain) return ''
  if (!safeStorage.isEncryptionAvailable()) return plain
  return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64')
}

/** 读取后开封：enc1: 前缀则解密；明文/空原样返回；解密失败返回 ''（数据不可恢复） */
export function openSecret(stored: string | null | undefined): string {
  if (!stored) return ''
  if (!stored.startsWith(ENC_PREFIX)) return stored
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'))
  } catch (e) {
    secretsLog.error('secrets decrypt failed (data sealed on another machine/user?)', e)
    return ''
  }
}

/** 是否已按密文存储 */
export function isSealed(stored: string | null | undefined): boolean {
  return !!stored && stored.startsWith(ENC_PREFIX)
}

/**
 * 启动迁移：存量明文敏感配置（ai.apiKey 等）加封为 enc1: 密文。
 * 加密不可用或已加封/为空时跳过；幂等，可在每次启动调用。
 */
export function migrateStoredSecrets(keys: string[]): void {
  if (!safeStorage.isEncryptionAvailable()) return
  for (const key of keys) {
    const v = getConfig(key)
    if (v && !isSealed(v)) setConfig(key, sealSecret(v))
  }
}

/**
 * 同上，但按**前缀**匹配（键名带账号、事前列不全的那些，如 `img:<wxid>:xorKey`）。
 * 返回本次实际加封的条数，供启动日志使用。
 */
export function migrateStoredSecretPrefixes(prefixes: string[]): number {
  if (!safeStorage.isEncryptionAvailable()) return 0
  const list = (prefixes ?? []).filter((p) => !!p)
  if (list.length === 0) return 0
  let sealed = 0
  for (const [key, value] of Object.entries(getAllConfig())) {
    if (!list.some((p) => key.startsWith(p))) continue
    if (value && !isSealed(value)) {
      setConfig(key, sealSecret(value))
      sealed += 1
    }
  }
  return sealed
}
