import { existsSync, readFileSync } from 'node:fs'
import { safeStorage } from 'electron'
import * as keyRepo from '../db/repos/keyStore'
import * as dbKeyMapRepo from '../db/repos/dbKeyMap'
import * as configRepo from '../db/repos/config'
import { testWxConnection } from './wechat/wxDb'
import { locateWeChatDbs } from './wechat/dbLocator'
import { verifyWxDbFileKey } from './wechat/decrypt'
import { matchKeyRingEntry, normalizeDbLabel } from './wechat/dbKeyLabels'
import { openSecret, sealSecret } from './secrets'
import type {
  KeySource,
  KeyAccountInfo,
  KeyStatusInfo,
  KeyLayer,
  KeyFileImportResult
} from '../../shared/types'

/**
 * 密钥管理（方案文档 §4.9）
 * 取 key 与用 key 解耦：客户端只安全持有 + 解密，不负责逆向取 key。
 *
 * 两层密钥，都要能存：
 * - **账号口令**（`key_store`，KDF 之前）：一个账号一把，配各库自己的 salt 派生，
 *   一把开全部库 —— 首选。
 * - **每库派生密钥**（`db_key_map`，KDF 之后）：微信 4.1.11+ 缓存的就是这些，
 *   配套工具默认也只能扫出这些；只开对应那一个库，作为拿不到口令时的兜底。
 */

export function isValidKeyHex(keyHex: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(keyHex.trim())
}

export interface KeyActionResult {
  success: boolean
  error?: string
}

/** 从密钥文件的一个条目里取出 64 位 hex（兼容裸字符串与其他工具的 enc_key 形态） */
function extractKeyHex(value: unknown): string | null {
  if (typeof value === 'string') return isValidKeyHex(value) ? value.trim() : null
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const field of ['enc_key', 'encKey', 'key', 'keyHex', 'dbKey', 'db_key']) {
      const candidate = record[field]
      if (typeof candidate === 'string' && isValidKeyHex(candidate)) return candidate.trim()
    }
  }
  return null
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
  if (!p || !p.keyEncrypted) return null
  try {
    return safeStorage.decryptString(Buffer.from(p.keyEncrypted, 'base64'))
  } catch {
    return null
  }
}

/* ── 每库派生密钥（密钥环） ── */

/** 该账号已导入的每库派生密钥（明文，仅主进程内存） */
export function getKeyRing(wxid: string): Map<string, string> {
  const ring = new Map<string, string>()
  if (!wxid) return ring
  for (const row of dbKeyMapRepo.getEntries(wxid)) {
    const plain = openSecret(row.keyEncrypted)
    if (plain && isValidKeyHex(plain)) ring.set(normalizeDbLabel(row.label), plain.trim())
  }
  return ring
}

export function getKeyRingSize(wxid: string): number {
  return wxid ? dbKeyMapRepo.countEntries(wxid) : 0
}

export function clearKeyRing(wxid: string): number {
  return wxid ? dbKeyMapRepo.deleteAll(wxid) : 0
}

/** 账号是否具备可用的密钥材料：口令或密钥环任一即可 */
export function hasAnyKey(wxid: string): boolean {
  return Boolean(getDecryptedKey(wxid)) || getKeyRingSize(wxid) > 0
}

/** 当前账号主要靠哪一层在工作（口令优先，它一把开全部库） */
export function getKeyLayer(wxid: string): KeyLayer {
  if (getDecryptedKey(wxid)) return 'passphrase'
  return getKeyRingSize(wxid) > 0 ? 'db-keys' : 'none'
}

/**
 * 解密某个库该用哪把密钥：
 * 密钥环里有这个库 → 用它的**派生密钥**（KDF 之后，只开这一个库）；
 * 否则回退到账号口令（KDF 之前，一把开全部库）。
 *
 * 这就是「一个账号一把口令」与「每库一把派生密钥」两种形态的统一入口，
 * 调用方只要把文件路径给它，不必关心密钥来自哪一层。
 */
export function resolveKeyForFile(wxid: string, filePath: string): string | null {
  const hit = matchKeyRingEntry(getKeyRing(wxid), filePath)
  if (hit) return hit
  return getDecryptedKey(wxid)
}

/**
 * 导入配套工具 wechat-decrypt-cli 产出的密钥文件：
 *
 *   { "version": 2, "passphrase": "<64hex>", "keys": { "session/session.db": "<64hex>" } }
 *
 * 版本 1（只有 `keys`）与平铺形态都接受。有口令就存成账号密钥；`keys` 一律进密钥环 ——
 * 这正是 4.1.11+ 默认扫描能拿到的全部东西（口令要 hook，通常还需管理员权限），
 * 所以即使没有口令也要能用。
 */
export function importKeyFile(
  wxid: string,
  filePath: string,
  dbPath = ''
): KeyFileImportResult {
  const id = (wxid || '').trim()
  const empty = { importedPassphrase: false, importedDbKeys: 0, keyRingSize: 0, skipped: 0 }
  if (!id) return { success: false, error: '请先填写当前微信账号 wxid', ...empty }
  if (!existsSync(filePath)) return { success: false, error: `密钥文件不存在：${filePath}`, ...empty }
  if (!safeStorage.isEncryptionAvailable()) {
    return { success: false, error: '系统加密不可用，无法安全保存密钥', ...empty }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return { success: false, error: '不是合法的 JSON 密钥文件', ...empty }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { success: false, error: '密钥文件应当是一个 JSON 对象', ...empty }
  }
  const envelope = parsed as Record<string, unknown>

  // 账号口令（版本 2 的 passphrase / 其他工具的 accountKey 写法）
  let passphrase = ''
  for (const field of ['passphrase', 'accountKey', 'account_key', 'passphraseHex']) {
    const candidate = envelope[field]
    if (typeof candidate === 'string' && isValidKeyHex(candidate)) {
      passphrase = candidate.trim()
      break
    }
  }

  // 每库密钥：{ keys: {...} } 信封或平铺对象
  const nested = envelope.keys
  const rawEntries = (
    nested && typeof nested === 'object' && !Array.isArray(nested) ? nested : envelope
  ) as Record<string, unknown>
  const entries: Array<{ label: string; keyEncrypted: string }> = []
  let skipped = 0
  for (const [label, value] of Object.entries(rawEntries)) {
    const keyHex = extractKeyHex(value)
    const normalized = normalizeDbLabel(label)
    if (!keyHex || !normalized) {
      // 口令字段本身会被算进 skipped，但那不是"跳过了一条坏密钥"，不计
      if (normalized && normalized !== 'version') skipped += 1
      continue
    }
    entries.push({ label: normalized, keyEncrypted: sealSecret(keyHex) })
  }

  if (!passphrase && !entries.length) {
    return { success: false, error: '文件里没有可用的 64 位十六进制密钥', ...empty, skipped }
  }
  if (passphrase) {
    const saved = importKey(id, passphrase, 'import', dbPath)
    if (!saved.success) return { success: false, error: saved.error, ...empty, skipped }
  } else {
    // 只有派生密钥时也要有 key_store 档案行：db_path 用来定位库、status 用来体检展示，
    // 否则密钥环会成为"孤儿"（能解密但界面上看不到账号、也无从试开校验）。
    const existing = keyRepo.getKey(id)
    keyRepo.upsertKey({
      wxid: id,
      dbPath: dbPath || existing?.dbPath || '',
      keyEncrypted: '',
      source: 'import',
      status: existing?.status ?? 'pending',
      importedAt: existing?.importedAt ?? Date.now(),
      updatedAt: Date.now()
    })
  }
  const importedDbKeys = dbKeyMapRepo.upsertEntries(id, entries)
  return {
    success: true,
    importedPassphrase: Boolean(passphrase),
    importedDbKeys,
    keyRingSize: getKeyRingSize(id),
    skipped
  }
}

/* ── 状态与校验 ── */

export function getKeyStatus(wxid: string): KeyStatusInfo {
  const p = keyRepo.getKey(wxid)
  const keyRingSize = getKeyRingSize(wxid)
  const layer = getKeyLayer(wxid)
  if (!p && keyRingSize === 0) {
    return {
      hasKey: false,
      status: null,
      source: null,
      dbPath: null,
      lastTestOk: null,
      keyRingSize: 0,
      layer: 'none'
    }
  }
  return {
    hasKey: hasAnyKey(wxid),
    status: p?.status ?? null,
    source: p?.source ?? null,
    dbPath: p?.dbPath || null,
    lastTestOk: p?.status === 'valid',
    keyRingSize,
    layer
  }
}

/** 已保存密钥的全部账号摘要（按最近更新倒序），供设置页下拉切换当前账号 */
export function listAccounts(): KeyAccountInfo[] {
  const byWxid = new Map<string, KeyAccountInfo>()
  for (const p of keyRepo.getKeys()) {
    const keyRingSize = getKeyRingSize(p.wxid)
    byWxid.set(p.wxid, {
      wxid: p.wxid,
      status: p.status,
      source: p.source,
      dbPath: p.dbPath || null,
      lastTestOk: p.status === 'valid',
      keyRingSize,
      layer: getKeyLayer(p.wxid)
    })
  }
  // 只导入了密钥文件（无账号口令）的账号在 key_store 里没有行，也要列出来
  for (const wxid of dbKeyMapRepo.listAccounts()) {
    if (byWxid.has(wxid)) continue
    byWxid.set(wxid, {
      wxid,
      status: null,
      source: 'import',
      dbPath: null,
      lastTestOk: null,
      keyRingSize: getKeyRingSize(wxid),
      layer: 'db-keys'
    })
  }
  return [...byWxid.values()]
}

/**
 * 验证密钥：优先「试开真实库」（T4），无 dbPath 时退化为格式校验。
 * 库能打开 -> valid；打不开 -> invalid 并记录原因。
 */
export function testKey(wxid: string): KeyActionResult {
  const key = getDecryptedKey(wxid)
  if (!key) return testKeyRingOnly(wxid)
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

/**
 * 没有账号口令时用密钥环验证：逐个库拿它自己的派生密钥试开。
 * 这是「导入密钥文件」之后的常态（口令要 hook 才能拿到，通常还需管理员权限）。
 */
function testKeyRingOnly(wxid: string): KeyActionResult {
  const size = getKeyRingSize(wxid)
  if (!size) return { success: false, error: '未找到可用密钥，请先导入' }
  const profile = keyRepo.getKey(wxid)
  const dbPath = profile?.dbPath || ''
  if (!dbPath) {
    // 没有数据目录就无从试开；密钥环本身合法（导入时已逐条校验格式），放行
    keyRepo.updateKeyStatus(wxid, 'valid')
    configRepo.setConfig(`key:${wxid}:error`, '')
    return { success: true }
  }
  const paths = locateWeChatDbs(dbPath, wxid)
  const files = [
    ...(paths.sessionDbFile ? [paths.sessionDbFile] : []),
    ...paths.msgDbFiles
  ]
  let opened = 0
  let failed = 0
  for (const file of files) {
    const resolved = resolveKeyForFile(wxid, file)
    if (resolved && verifyWxDbFileKey(file, resolved).ok) opened += 1
    else failed += 1
  }
  if (opened === 0) {
    const reason = files.length
      ? `密钥环里的派生密钥都打不开本账号的库（0/${files.length}）`
      : '未在数据目录下找到任何库文件'
    keyRepo.updateKeyStatus(wxid, 'invalid')
    configRepo.setConfig(`key:${wxid}:error`, reason)
    return { success: false, error: reason }
  }
  keyRepo.updateKeyStatus(wxid, 'valid')
  configRepo.setConfig(
    `key:${wxid}:error`,
    failed > 0 ? `有 ${failed}/${files.length} 个库没有对应的派生密钥` : ''
  )
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
