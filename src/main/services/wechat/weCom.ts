import type Database from 'better-sqlite3-multiple-ciphers'

/**
 * 企业微信（openim）显示名解析（移植自 CipherTalk weComParser/weComResolver，适配本项目直连 sqlite）。
 *
 * 微信 4.x 中企业微信用户（username 形如 `<数字>@openim`）的展示信息不在 contact 常规列：
 * - 「企业展示名 / 文案」：contact 行 extra_buffer（protobuf-like 二进制）前两字段 =
 *   field1 app_id、field2 wording_id（形如 `xxxRI…@im.wxwork`），文案本体存
 *   contact.db 的 `openim_wording` 表（app_id/wording_id/lang_id → wording）；
 * - 无 wording 表时兜底：从 extra_buffer 启发式提取最像企业名的字符串。
 * 所有函数失败静默返回 undefined，不影响主链路。
 */

const WXWORK_SUFFIX = '@im.wxwork'

/** extra_buffer 各种序列化形态 → Buffer（移植 decodeExtraBuffer） */
export function decodeExtraBuffer(raw: unknown): Buffer | null {
  if (!raw) return null
  if (Buffer.isBuffer(raw)) return raw
  if (raw instanceof Uint8Array) return Buffer.from(raw)
  if (Array.isArray(raw)) return Buffer.from(raw)
  if (typeof raw === 'object') {
    const o = raw as { type?: string; value?: string; data?: unknown }
    if (o.type === 'bytes' && typeof o.value === 'string') return Buffer.from(o.value, 'base64')
    if (Array.isArray(o.data)) return Buffer.from(o.data as number[])
  }
  if (typeof raw !== 'string') return null
  const t = raw.trim()
  if (!t) return null
  if (/^[0-9a-fA-F]+$/.test(t) && t.length % 2 === 0) return Buffer.from(t, 'hex')
  return Buffer.from(t, 'base64')
}

function readProtoVarint(data: Buffer, start: number): { value: number; next: number } | null {
  let value = 0
  let shift = 0
  for (let offset = start; offset < data.length && shift <= 28; offset++) {
    const byte = data[offset]
    value += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) return { value, next: offset + 1 }
    shift += 7
  }
  return null
}

/** 提取 extra_buffer 前两个 protobuf 字符串字段：app_id 与 wording_id（移植 extractWeComWordingRef） */
export function extractWeComWordingRef(raw: unknown): { appId?: string; wordingId: string } | null {
  const data = decodeExtraBuffer(raw)
  if (!data || data.length === 0) return null

  let appId: string | undefined
  let wordingId: string | undefined
  let offset = 0
  while (offset < data.length) {
    const tag = readProtoVarint(data, offset)
    if (!tag) break
    offset = tag.next
    const fieldNumber = tag.value >>> 3
    const wireType = tag.value & 0x07
    if (wireType === 0) {
      const v = readProtoVarint(data, offset)
      if (!v) break
      offset = v.next
      continue
    }
    if (wireType === 1) {
      offset += 8
      continue
    }
    if (wireType === 5) {
      offset += 4
      continue
    }
    if (wireType !== 2) break

    const len = readProtoVarint(data, offset)
    if (!len || len.value < 0 || len.next + len.value > data.length) break
    offset = len.next + len.value
    const text = data.slice(len.next, offset).toString('utf-8')
    if (text.includes('\uFFFD')) continue
    if (fieldNumber === 1 && /^\d+$/.test(text)) appId = text
    else if (fieldNumber === 2 && text.toLowerCase().endsWith(WXWORK_SUFFIX)) wordingId = text
  }
  if (!wordingId) {
    const m = data.toString('utf-8').match(/[A-Za-z0-9]+RI\d+@im\.wxwork/i)
    wordingId = m?.[0]
  }
  return wordingId ? { appId, wordingId } : null
}

/** openim_wording 表查中文文案（移植 weComResolver 查询分支；表不存在/无命中返回 undefined） */
export function queryOpenimWording(
  db: Database.Database,
  ref: { appId?: string; wordingId: string }
): string | undefined {
  try {
    const table = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='openim_wording'`)
      .get() as { name: string } | undefined
    if (!table) return undefined
    const sql = ref.appId
      ? `SELECT wording FROM openim_wording
         WHERE app_id = ? AND wording_id = ? AND wording <> ''
         ORDER BY CASE WHEN lang_id = 1 THEN 0 ELSE 1 END, update_time DESC LIMIT 1`
      : `SELECT wording FROM openim_wording
         WHERE wording_id = ? AND wording <> ''
         ORDER BY CASE WHEN lang_id = 1 THEN 0 ELSE 1 END, update_time DESC LIMIT 1`
    const row = db.prepare(sql).get(ref.appId ? [ref.appId, ref.wordingId] : [ref.wordingId]) as
      { wording?: string } | undefined
    const wording = typeof row?.wording === 'string' ? row.wording.trim() : ''
    return wording || undefined
  } catch {
    return undefined
  }
}

/** 从 extra_buffer 启发式提取最像企业名的字符串（移植 extractWeComCorpName 的收集/评分逻辑） */
export function extractWeComCorpName(
  raw: unknown,
  knownStrings: Array<string | undefined>
): string | undefined {
  try {
    const data = decodeExtraBuffer(raw)
    if (!data || data.length < 4) return undefined

    const candidates: string[] = []
    let offset = 0
    while (offset < data.length - 1) {
      const tag = data[offset]
      offset++
      let length = data[offset]
      offset++
      // 长度可能是变长编码（最高位为续位指示）
      if (length > 127 && offset < data.length) {
        const ext = data[offset]
        length = (length & 0x7f) | (ext << 7)
        if (length > data.length) length = data[offset - 1] & 0x7f
        else offset++
      }
      if (length <= 0 || offset + length > data.length) continue
      const slice = data.slice(offset, offset + length)
      offset += length
      const str = slice.toString('utf-8')
      if (!str || str.length < 2 || str.length > 50) continue
      if (/^@/.test(str)) continue
      // eslint-disable-next-line no-control-regex -- 有意过滤含控制字符/替换符的候选串
      if (/[\x00-\x1F\x7F\uFFFD]/.test(str)) continue
      candidates.push(str)
      if (tag === 0) break // 防止错误回退导致无限循环
    }
    if (candidates.length === 0) return undefined

    const known = new Set(
      knownStrings.filter((s): s is string => typeof s === 'string' && s.length > 0)
    )
    const looksLikePhone = (s: string): boolean => /^\+?\d[\d\s-]{6,}$/.test(s)
    const looksLikeUrl = (s: string): boolean =>
      /^https?:\/\//i.test(s) || /\.(com|cn|net|org)\b/i.test(s)
    const looksLikeEmail = (s: string): boolean => /@.+\./.test(s)
    const looksLikeWxid = (s: string): boolean => /^wxid_/.test(s) || /@openim$/i.test(s)
    const looksLikeName = (s: string): boolean =>
      /[一-龥A-Za-z]/.test(s) && !/^[\d.\-+\s]+$/.test(s)

    const ranked = candidates
      .filter((s) => !known.has(s))
      .filter((s) => !looksLikePhone(s))
      .filter((s) => !looksLikeUrl(s))
      .filter((s) => !looksLikeEmail(s))
      .filter((s) => !looksLikeWxid(s))
      .filter(looksLikeName)
      .sort((a, b) => {
        const aGood = a.length >= 3 ? 1 : 0
        const bGood = b.length >= 3 ? 1 : 0
        if (aGood !== bGood) return bGood - aGood
        return b.length - a.length
      })
    return ranked[0]
  } catch {
    return undefined
  }
}

/** 综合入口：优先 openim_wording 文案，其次 extra_buffer 企业名（失败静默） */
export function resolveOpenimDisplayName(
  db: Database.Database,
  extraBuffer: unknown,
  knownStrings: Array<string | undefined>
): string | undefined {
  const ref = extractWeComWordingRef(extraBuffer)
  if (ref) {
    const wording = queryOpenimWording(db, ref)
    if (wording) return wording
  }
  return extractWeComCorpName(extraBuffer, knownStrings)
}
