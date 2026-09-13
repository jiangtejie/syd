/**
 * 飞书多维表格(Base)同步 —— 议题证据明细子表(默认关闭:客户原文外发,保守优先)。
 *
 * 覆盖:证据同步配置(天数/每议题条数/每条字数/附件开关:图片+视频)、按需建「议题证据」子表、
 * 每议题挑选(首现 1 条 + 最新 N 条)、append-only 推送、图片证据上传成附件、孤儿行清理。
 */

import { getConfig, getConfigBoolean, setConfig } from '../../db/repos/config'
import { getSyncRef, listSyncRefs, saveSyncRef } from '../../db/repos/larkSyncRepo'
import { larkCall } from './client'
import { evidenceToFields, hashOf } from './baseMapping'
import { listEvidenceForSync, listEvidenceIds } from '../../db/repos/issueRepo'
import {
  clearAttached,
  clearMediaRefs,
  hasAttached,
  markAttached
} from '../../db/repos/larkMediaRepo'
import { uploadEvidenceMedia } from './mediaUpload'
import {
  DEFAULT_MAX_MEDIA_MB,
  DEFAULT_MAX_UPLOADS_PER_ROUND,
  attachmentFieldValue,
  evidenceMediaKind,
  evidenceMediaMd5Of,
  type EvidenceMediaKind
} from './evidenceMedia'
import { createLogger } from '../logging'
import {
  EVIDENCE_TABLE_NAME,
  CFG_TABLE_ISSUES,
  CFG_EV_ENABLED,
  CFG_EV_DAYS,
  CFG_EV_MAX_PER_ISSUE,
  CFG_EV_MAX_CHARS,
  CFG_EV_MEDIA,
  CFG_EV_MAX_MB,
  CFG_EV_MAX_UPLOADS,
  CFG_EV_TABLE,
  CFG_EV_LINK,
  CFG_EV_LAST_AT,
  CFG_EV_LAST,
  DAY_MS,
  BATCH_SIZE,
  BATCH_GAP_MS,
  EVIDENCE_FIELDS,
  baseConfiguredLink,
  pushHistory,
  sleep,
  ensureTable,
  type SyncOutResult
} from './baseCore'

const syncLog = createLogger('lark')

/** 按当前开关与三重上限,算出"本轮还会推几条证据"(开关关闭时恒为 0) */
export function countPendingEvidence(): number {
  const cfg = getEvidenceConfig()
  if (!cfg.enabled) return 0
  try {
    const all = listEvidenceForSync({ sinceMs: Date.now() - cfg.days * DAY_MS, limit: 5000 })
    const mapped = new Set(listSyncRefs('evidence').map((r) => r.localId))
    return pickPerIssue(
      all.filter((r) => !mapped.has(r.msgId)),
      cfg.maxPerIssue
    ).length
  } catch {
    return 0
  }
}

export function readLastEvidence(): SyncOutResult | null {
  const raw = getConfig(CFG_EV_LAST)
  if (!raw) return null
  try {
    return JSON.parse(raw) as SyncOutResult
  } catch {
    return null
  }
}

/** 清掉素材与附件缓存(baseClear / 换 Base 用):token 是 Base 级的,换表即失效 */
export function resetEvidenceMedia(): { media: number; attached: number } {
  return { media: clearMediaRefs(), attached: clearAttached() }
}

export interface EvidenceConfig {
  enabled: boolean
  days: number
  maxPerIssue: number
  maxChars: number
  tableId: string
  /** 是否把证据的图片/视频传到「证据图」附件列(默认关:原图比文字更敏感) */
  media: boolean
  /** 单张图片上限(MB) */
  maxMediaMB: number
  /** 单轮最多上传几张(限流闸门) */
  maxUploadsPerRound: number
}

export function getEvidenceConfig(): EvidenceConfig {
  const num = (k: string, d: number, lo: number, hi: number): number => {
    const n = Number(getConfig(k) ?? d)
    return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n) : d
  }
  return {
    enabled: getConfigBoolean(CFG_EV_ENABLED, false),
    days: num(CFG_EV_DAYS, 7, 1, 365),
    maxPerIssue: num(CFG_EV_MAX_PER_ISSUE, 20, 1, 200),
    maxChars: num(CFG_EV_MAX_CHARS, 200, 20, 2000),
    tableId: (getConfig(CFG_EV_TABLE) ?? '').trim(),
    media: getConfigBoolean(CFG_EV_MEDIA, false),
    maxMediaMB: num(CFG_EV_MAX_MB, DEFAULT_MAX_MEDIA_MB, 1, 20),
    maxUploadsPerRound: num(CFG_EV_MAX_UPLOADS, DEFAULT_MAX_UPLOADS_PER_ROUND, 1, 200)
  }
}

export function setEvidenceConfig(patch: {
  enabled?: boolean
  days?: number
  maxPerIssue?: number
  maxChars?: number
  media?: boolean
  maxMediaMB?: number
  maxUploadsPerRound?: number
}): EvidenceConfig {
  if (typeof patch.enabled === 'boolean') setConfig(CFG_EV_ENABLED, patch.enabled ? '1' : '0')
  if (Number.isFinite(Number(patch.days)))
    setConfig(CFG_EV_DAYS, String(Math.min(Math.max(Math.round(Number(patch.days)), 1), 365)))
  if (Number.isFinite(Number(patch.maxPerIssue)))
    setConfig(
      CFG_EV_MAX_PER_ISSUE,
      String(Math.min(Math.max(Math.round(Number(patch.maxPerIssue)), 1), 200))
    )
  if (Number.isFinite(Number(patch.maxChars)))
    setConfig(
      CFG_EV_MAX_CHARS,
      String(Math.min(Math.max(Math.round(Number(patch.maxChars)), 20), 2000))
    )
  if (typeof patch.media === 'boolean') setConfig(CFG_EV_MEDIA, patch.media ? '1' : '0')
  if (Number.isFinite(Number(patch.maxMediaMB)))
    setConfig(
      CFG_EV_MAX_MB,
      String(Math.min(Math.max(Math.round(Number(patch.maxMediaMB)), 1), 20))
    )
  if (Number.isFinite(Number(patch.maxUploadsPerRound)))
    setConfig(
      CFG_EV_MAX_UPLOADS,
      String(Math.min(Math.max(Math.round(Number(patch.maxUploadsPerRound)), 1), 200))
    )
  return getEvidenceConfig()
}

/**
 * 确保「议题证据」子表存在(按需创建,不在验证流程里强建)并尝试建立与议题表的关联字段。
 * 关联字段失败不致命:退化为「议题ID 文本列 + Base 视图分组」。
 */
export async function ensureEvidenceTable(
  appToken: string,
  issuesTableId?: string
): Promise<{
  tableId: string
  created: boolean
  fieldsAdded: string[]
  linkOk: boolean
  note?: string
}> {
  const t = await ensureTable(appToken, EVIDENCE_TABLE_NAME, EVIDENCE_FIELDS)
  setConfig(CFG_EV_TABLE, t.tableId)
  let linkOk = !!(getConfig(CFG_EV_LINK) ?? '').trim()
  let note: string | undefined
  // 关联字段:单向关联(type=18) 指向议题表;已建过就不重复试
  if (!linkOk && issuesTableId) {
    const linkFieldName = '关联议题'
    const r = await larkCall((api) =>
      api.bitable.appTableField.create({
        path: { app_token: appToken, table_id: t.tableId },
        data: { field_name: linkFieldName, type: 18, property: { table_id: issuesTableId } }
      })
    )
    if (r.ok) {
      linkOk = true
      setConfig(CFG_EV_LINK, linkFieldName)
    } else {
      note = `关联字段未创建(不影响同步): ${r.error} —— 可在证据表按「议题ID」分组查看`
      syncLog.warn(note)
    }
  }
  return { tableId: t.tableId, created: t.created, fieldsAdded: t.fieldsAdded, linkOk, note }
}

/** 每议题挑选要推的证据:首现 1 条 + 最新 (max-1) 条(其余留给本地/后续补推) */
export function pickPerIssue<T extends { issueId: number; seqNo: number }>(
  rows: T[],
  max: number
): T[] {
  const byIssue = new Map<number, T[]>()
  for (const r of rows) {
    const list = byIssue.get(r.issueId) ?? []
    list.push(r)
    byIssue.set(r.issueId, list)
  }
  const out: T[] = []
  for (const list of byIssue.values()) {
    const sorted = [...list].sort((a, b) => a.seqNo - b.seqNo)
    if (sorted.length <= max) {
      out.push(...sorted)
      continue
    }
    out.push(sorted[0])
    out.push(...sorted.slice(sorted.length - (max - 1)))
  }
  return out.sort((a, b) => a.seqNo - b.seqNo)
}

/**
 * 推送证据明细到子表(默认关闭;开启后受 天数 / 每议题条数 / 每条字数 三重上限)。
 * 证据 append-only:按 证据ID 映射一次即长期有效,不存在冲突。
 */
/**
 * 可上传附件的那一行属于哪种类型（图片/视频）。
 * 文件证据目前只登记 md5 与文件名，不上传附件 → 返回 null（避免做出半成品解析）。
 */
function attachableKindOf(row: {
  localType?: number
  imageMd5?: string
  videoMd5?: string
  fileMd5?: string
}): EvidenceMediaKind | null {
  const kind = evidenceMediaKind(row.localType, row)
  return kind === 'file' ? null : kind
}

export async function syncEvidenceOut(): Promise<SyncOutResult> {
  const at = Date.now()
  const empty: SyncOutResult = {
    ok: false,
    scanned: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    at
  }
  const cfg = getEvidenceConfig()
  if (!cfg.enabled) return { ...empty, error: '证据明细同步未开启(设置页可开)' }
  const appToken = baseConfiguredLink()
  if (!appToken) return { ...empty, error: '未配置多维表格链接' }

  let tableId = cfg.tableId
  try {
    // 开了附件就必须确认「证据图」列存在:表是本功能更早的版本建的,那时还没有这一列
    if (!tableId || cfg.media) {
      const ensured = await ensureEvidenceTable(
        appToken,
        (getConfig(CFG_TABLE_ISSUES) ?? '').trim()
      )
      tableId = ensured.tableId
    }
  } catch (e) {
    return {
      ...empty,
      error: `创建「${EVIDENCE_TABLE_NAME}」表失败: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  const sinceMs = Date.now() - cfg.days * DAY_MS
  const all = listEvidenceForSync({ sinceMs, limit: 5000 })
  const mapped = new Set(listSyncRefs('evidence').map((r) => r.localId))
  const fresh = all.filter((r) => !mapped.has(r.msgId))
  const picked = pickPerIssue(fresh, cfg.maxPerIssue)

  const out: SyncOutResult = {
    ok: true,
    scanned: all.length,
    created: 0,
    updated: 0,
    skipped: all.length - fresh.length,
    failed: 0,
    at
  }
  /** 本轮要写附件的证据行(先放新建的行,后面再补历史上已推送但没写附件的) */
  const attachQueue: Array<{
    msgId: number
    recordId: string
    accountWxid: string
    /** 可上传的类型（图片/视频）；文件证据不入队（只登记） */
    kind: EvidenceMediaKind
    md5: string
  }> = []

  /** 消息 id → 证据行(flush 里要把新建的图片行挑出来写附件,放在 flush 之前以免顺序被误改) */
  const pickedByMsgId = new Map(picked.map((r) => [r.msgId, r]))
  let pending: Array<{ id: number; fields: Record<string, unknown>; hash: string }> = []
  const flush = async (): Promise<void> => {
    if (pending.length === 0) return
    const batch = pending
    pending = []
    const r = await larkCall<{ records?: Array<{ record_id?: string }> }>((api) =>
      api.bitable.appTableRecord.batchCreate({
        path: { app_token: appToken, table_id: tableId },
        data: { records: batch.map((b) => ({ fields: b.fields })) }
      })
    )
    if (!r.ok) {
      out.failed += batch.length
      syncLog.warn(`批量新增证据失败 ${batch.length} 条: ${r.error}`)
      return
    }
    const records = r.data.records ?? []
    batch.forEach((b, idx) => {
      const recordId = records[idx]?.record_id
      if (!recordId) {
        out.failed++
        return
      }
      saveSyncRef('evidence', b.id, appToken, tableId, recordId, b.hash, {
        status: '',
        assignee: '',
        pushed: true
      })
      out.created++
    })
    // 新建的行里,图片证据要接着把真图写进附件列
    if (cfg.media) {
      batch.forEach((b, idx) => {
        const recordId = records[idx]?.record_id
        const src = pickedByMsgId.get(b.id)
        if (!recordId || !src || !src.accountWxid) return
        const kind = attachableKindOf(src)
        const md5 = kind ? evidenceMediaMd5Of(kind, src) : null
        if (!kind || !md5) return
        attachQueue.push({ msgId: src.msgId, recordId, accountWxid: src.accountWxid, kind, md5 })
      })
    }
    await sleep(BATCH_GAP_MS)
  }

  for (const row of picked) {
    const fields = evidenceToFields(row, { maxChars: cfg.maxChars })
    pending.push({ id: row.msgId, fields, hash: hashOf(fields) })
    if (pending.length >= BATCH_SIZE) await flush()
  }
  await flush()

  // 附件:先把历史行补上(附件开关常常是后开的),再一起写(每轮限量,剩下的下一轮继续)
  if (cfg.media) {
    for (const row of all) {
      if (attachQueue.length >= cfg.maxUploadsPerRound) break
      if (!row.accountWxid) continue
      const kind = attachableKindOf(row)
      const md5 = kind ? evidenceMediaMd5Of(kind, row) : null
      if (!kind || !md5) continue
      if (attachQueue.some((a) => a.msgId === row.msgId)) continue
      if (hasAttached(row.msgId)) continue
      const ref = getSyncRef('evidence', row.msgId)
      if (!ref || ref.tableId !== tableId) continue
      attachQueue.push({
        msgId: row.msgId,
        recordId: ref.recordId,
        accountWxid: row.accountWxid,
        kind,
        md5
      })
    }
    await attachEvidenceImages({
      appToken,
      tableId,
      queue: attachQueue.slice(0, cfg.maxUploadsPerRound),
      cfg,
      out
    })
  }

  setConfig(CFG_EV_LAST_AT, String(at))
  setConfig(CFG_EV_LAST, JSON.stringify(out))
  if (out.failed > 0) out.ok = false
  pushHistory('evidence', out)
  return out
}

/**
 * 把图片证据写进 Base 的「证据图」附件列。
 *
 * 两段式:先把图上传成素材拿 file_token(同一张图按 md5 复用,不重复上传),
 * 再 batchUpdate 记录写附件列。**只有记录更新成功才标记已写**,失败下一轮自动重试。
 * 全程不致命:附件传不上去不影响这一行的证据文本,只在计数与日志里体现。
 */
export async function attachEvidenceImages(opts: {
  appToken: string
  tableId: string
  queue: Array<{
    msgId: number
    recordId: string
    accountWxid: string
    kind: EvidenceMediaKind
    md5: string
  }>
  cfg: EvidenceConfig
  out: SyncOutResult
}): Promise<void> {
  const { appToken, tableId, queue, cfg, out } = opts
  if (queue.length === 0) return

  let batch: Array<{
    recordId: string
    msgId: number
    md5: string
    token: string
  }> = []
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return
    const items = batch
    batch = []
    const records = items.map((it) => ({
      record_id: it.recordId,
      fields: { 证据图: attachmentFieldValue(it.token) }
    }))
    const r = await larkCall((api) =>
      api.bitable.appTableRecord.batchUpdate({
        path: { app_token: appToken, table_id: tableId },
        data: { records }
      })
    )
    if (!r.ok) {
      out.mediaFailed = (out.mediaFailed ?? 0) + items.length
      syncLog.warn('写入证据附件失败 ' + items.length + ' 条: ' + r.error)
      return
    }
    for (const it of items) markAttached(it.msgId, it.md5, it.token)
    out.mediaUploaded = (out.mediaUploaded ?? 0) + items.length
    await sleep(BATCH_GAP_MS)
  }

  for (const item of queue) {
    const up = await uploadEvidenceMedia({
      appToken,
      accountWxid: item.accountWxid,
      kind: item.kind,
      md5: item.md5,
      maxMediaMB: cfg.maxMediaMB
    })
    if (!up.ok || !up.fileToken) {
      if (up.skipped) out.mediaSkipped = (out.mediaSkipped ?? 0) + 1
      else out.mediaFailed = (out.mediaFailed ?? 0) + 1
      continue
    }
    if (up.cached) out.mediaCached = (out.mediaCached ?? 0) + 1
    batch.push({ recordId: item.recordId, msgId: item.msgId, md5: item.md5, token: up.fileToken })
    if (batch.length >= BATCH_SIZE) await flush()
  }
  await flush()
}

/**
 * 清理孤儿证据行:远程子表里 证据ID 在本地已不存在(议题删除级联删了证据)的行。
 * 只删我们自己写入的行(证据ID 非空且不在本地集合中),不动同事手填的行。
 */
export async function cleanOrphanEvidence(): Promise<{
  ok: boolean
  error?: string
  removed: number
}> {
  const cfg = getEvidenceConfig()
  const appToken = baseConfiguredLink()
  if (!appToken || !cfg.tableId) return { ok: false, error: '证据表未创建', removed: 0 }
  // 按本地真实存在的证据 id 判断(映射表在议题删除后仍会残留,不能当判据)
  const local = listEvidenceIds()
  let removed = 0
  try {
    for (let page = 0; page < 20; page += 1) {
      const r = await larkCall<{
        items?: Array<{ record_id?: string; fields?: Record<string, unknown> }>
        has_more?: boolean
        page_token?: string
      }>((api) =>
        api.bitable.appTableRecord.list({
          path: { app_token: appToken, table_id: cfg.tableId },
          params: { page_size: 500, field_names: JSON.stringify(['证据ID']) }
        })
      )
      if (!r.ok) return { ok: false, error: r.error, removed }
      const orphans: string[] = []
      for (const it of r.data.items ?? []) {
        const idText = String((it.fields ?? {})['证据ID'] ?? '').trim()
        const id = Number.parseInt(idText, 10)
        if (!Number.isFinite(id) || local.has(id)) continue
        if (it.record_id) orphans.push(it.record_id)
      }
      for (const recordId of orphans) {
        const del = await larkCall((api) =>
          api.bitable.appTableRecord.delete({
            path: { app_token: appToken, table_id: cfg.tableId, record_id: recordId }
          })
        )
        if (del.ok) removed++
        await sleep(BATCH_GAP_MS)
      }
      if (!r.data.has_more) break
    }
    return { ok: true, removed }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), removed }
  }
}
