import { basename, isAbsolute, relative } from 'node:path'

/**
 * 数据库标签与密钥环匹配（纯函数，供密钥文件导入与逐库取密钥复用）。
 *
 * 为什么需要它：一个账号的密钥表是按**相对 db_storage 的路径**存的
 * （`session/session.db`），而调用方手里往往只有文件绝对路径
 * （`C:\...\db_storage\session\session.db`），两者必须能对上。
 *
 * 三级匹配（与配套取密钥工具 wechat-decrypt-cli 的 resolveKeyForDb 语义一致，
 * 这样工具产出的密钥文件可以被本应用直接导入）：
 * 1. 精确相等；
 * 2. 调用方路径以 `/<label>` 结尾（覆盖绝对路径）；
 * 3. 退化为文件名匹配（`session.db` ↔ `session/session.db`）。
 */

/** 归一化标签：正斜杠、小写、去掉盘符与开头的 `./`、折叠重复斜杠 */
export function normalizeDbLabel(label: string): string {
  return String(label || '')
    .replace(/\\/g, '/')
    .replace(/^[a-zA-Z]:\//, '')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '')
    .toLowerCase()
}

/**
 * 文件绝对路径 → 相对 db_storage 的标签；不在 db_storage 之下时返回 null。
 * 用于**导入**：把用户选中的路径写成人可读、可跨机迁移的标签。
 */
export function dbLabelFromPath(dbStoragePath: string, filePath: string): string | null {
  const root = String(dbStoragePath || '').trim()
  if (!root || !isAbsolute(root) || !isAbsolute(filePath)) return null
  const rel = relative(root, filePath)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  const normalized = normalizeDbLabel(rel)
  return normalized || null
}

/**
 * 在密钥环里找这个文件对应的密钥。
 * 传入的可以是绝对路径、相对标签或裸文件名。
 */
export function matchKeyRingEntry(
  ring: ReadonlyMap<string, string>,
  filePathOrLabel: string
): string | null {
  if (!ring.size) return null
  const normalized = normalizeDbLabel(filePathOrLabel)
  if (!normalized) return null
  const direct = ring.get(normalized)
  if (direct) return direct
  for (const [label, keyHex] of ring) {
    if (label && normalized.endsWith(`/${label}`)) return keyHex
  }
  const base = normalizeDbLabel(basename(normalized))
  if (base) {
    for (const [label, keyHex] of ring) {
      if (label === base || label.endsWith(`/${base}`)) return keyHex
    }
  }
  return null
}
