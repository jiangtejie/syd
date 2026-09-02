import { safeStorage } from 'electron'
import * as keyRepo from '../db/repos/keyStore'
import * as configRepo from '../db/repos/config'
import { testWxConnection } from './wechat/wxDb'
import type { KeySource, KeyAccountInfo, KeyStatusInfo } from '../../shared/types'

/**
 * 密钥管理（方案文档 §4.9）
 * 取 key 与用 key 解耦：客户端只安全持有 + 解密，不负责逆向取 key。
 */

export function isValidKeyHex(keyHex: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(keyHex.trim())
}

export interface KeyActionResult {
  success: boolean
  error?: string
}

/** 外部导入 key：64 位十六进制 → safeStorage 加密后落库 */
export function importKey(
  wxid: string,
  keyHex: string,
  source: KeySource,
  dbPath = ''
): KeyActionResult {
  const hex = keyHex.trim()
  if (!isValidKeyHex(hex)) {
    return { success: false, error: 'key 必须是 64 位十六进制（32 字节），请检查导入内容' }
  }
  if (!safeStorage.isEncryptionAvailable()) {
    return { success: false, error: '系统加密不可用，无法安全保存密钥' }
  }
  const now = Date.now()
  keyRepo.upsertKey({
    wxid,
    dbPath,
    keyEncrypted: safeStorage.encryptString(hex).toString('base64'),
    source,
    status: 'pending',
    importedAt: now,
    updatedAt: now
  })
  return { success: true }
}

/** 解密还原明文 key（仅主进程内存中持有，不落盘） */
export function getDecryptedKey(wxid: string): string | null {
  const p = keyRepo.getKey(wxid)
  if (!p) return null
  try {
    return safeStorage.decryptString(Buffer.from(p.keyEncrypted, 'base64'))
  } catch {
    return null
  }
}

export function getKeyStatus(wxid: string): KeyStatusInfo {
  const p = keyRepo.getKey(wxid)
  if (!p) {
    return { hasKey: false, status: null, source: null, dbPath: null, lastTestOk: null }
  }
  return {
    hasKey: true,
    status: p.status,
    source: p.source,
    dbPath: p.dbPath,
    lastTestOk: p.status === 'valid'
  }
}

/** 已保存密钥的全部账号摘要（按最近更新倒序），供设置页下拉切换当前账号 */
export function listAccounts(): KeyAccountInfo[] {
  return keyRepo.getKeys().map((p) => ({
    wxid: p.wxid,
    status: p.status,
    source: p.source,
    dbPath: p.dbPath || null,
    lastTestOk: p.status === 'valid'
  }))
}

/**
 * 验证密钥：优先「试开真实库」（T4），无 dbPath 时退化为格式校验。
 * 库能打开 -> valid；打不开 -> invalid 并记录原因。
 */
export function testKey(wxid: string): KeyActionResult {
  const key = getDecryptedKey(wxid)
  if (!key) return { success: false, error: '未找到可用密钥，请先导入' }
  if (!isValidKeyHex(key)) {
    keyRepo.updateKeyStatus(wxid, 'invalid')
    configRepo.setConfig(`key:${wxid}:error`, '密钥格式无效（应为 64 位十六进制）')
    return { success: false, error: '密钥格式无效（应为 64 位十六进制）' }
  }
  const profile = keyRepo.getKey(wxid)
  if (profile?.dbPath) {
    const result = testWxConnection(profile.dbPath, wxid, key)
    if (!result.ok) {
      keyRepo.updateKeyStatus(wxid, 'invalid')
      configRepo.setConfig(`key:${wxid}:error`, result.error || '')
      return { success: false, error: result.error || '数据库打开失败' }
    }
  }
  keyRepo.updateKeyStatus(wxid, 'valid')
  configRepo.setConfig(`key:${wxid}:error`, '')
  return { success: true }
}

/** 连接成功时标记 valid（供 wxService.connect 回调） */
export function markKeyValid(wxid: string): void {
  keyRepo.updateKeyStatus(wxid, 'valid')
  configRepo.setConfig(`key:${wxid}:error`, '')
}

/** 连接失败时标记 invalid 并记录原因 */
export function markKeyInvalid(wxid: string, reason?: string): void {
  keyRepo.updateKeyStatus(wxid, 'invalid')
  if (reason) configRepo.setConfig(`key:${wxid}:error`, reason)
}

/**
 * 触发重新获取。注册表直读依赖微信具体版本（待 M3 实现探测），
 * 当前版本返回 wxid 现有状态，提示走手动导入。
 */
export function refreshKey(wxid: string): KeyStatusInfo {
  return getKeyStatus(wxid)
}
