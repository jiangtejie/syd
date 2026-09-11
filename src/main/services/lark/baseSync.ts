import { getConfig, getConfigBoolean, setConfig } from '../../db/repos/config'
import {
  countSyncRefs,
  dropSyncRef,
  getSyncRef,
  listSyncRefs,
  saveRemoteCollab,
  saveSyncRef
} from '../../db/repos/larkSyncRepo'
import {
  getIssueById,
  listIssuesChangedSince,
  setIssueAssignee,
  setIssueNote,
  setIssueStatus
} from '../../db/repos/issueRepo'
import { listRepliesChangedSince } from '../../db/repos/agentReplyRepo'
import { listTeamMembers } from '../../db/repos/teamRepo'
import { larkCall, larkErrorHint } from './client'
import {
  assigneeFromText,
  collabOf,
  diffCollab,
  hashOf,
  issueToFields,
  replyToFields,
  statusFromText
} from './baseMapping'
import { parseLarkRef } from './url'
import { createLogger } from '../logging'

const syncLog = createLogger('lark')

/**
 * 议题 → 飞书多维表格（Base）单向同步（M1：只出不进）。
 *
 * 为什么先做「只出不进」：先把同事能不能在手机上看板、愿不愿意用这件事验证掉，
 * 再决定要不要做双向回写与权限体系。回写（Base → 本地）是 M2，不在这里。
 *
 * 三个必须记住的设计点：
 * 1. **Base 没有唯一键** → 靠 lark_sync_map(kind, local_id) 记 record_id 做幂等 upsert；
 * 2. **内容 hash 未变就跳过写** → 省限流额度，也让「同事在 Base 里改过的列」不被无谓覆盖（M1 只写程序列）；
 * 3. **默认脱敏**：只推标题/摘要/群名，不推聊天原文（lark.sync.rawEvidence=1 才推）。
 */

/** 表名（按名字查找/创建，重名与否都能被 ensureTables 处理） */
export const ISSUE_TABLE_NAME = '议题'
export const REPLY_TABLE_NAME = '数字员工回复'

/** 配置键 */
const CFG_TOKEN = 'lark.baseToken'
const CFG_TABLE_ISSUES = 'lark.baseTableIssues'
const CFG_TABLE_REPLIES = 'lark.baseTableReplies'
const CFG_SYNC_ENABLED = 'lark.sync.enabled'
const CFG_RAW_EVIDENCE = 'lark.sync.rawEvidence'
const CFG_LAST_AT = 'lark.sync.lastAt'
const CFG_LAST_RESULT = 'lark.sync.lastResult'
const CFG_LAST_PULL = 'lark.sync.lastPull'
const CFG_LAST_REPLIES_AT = 'lark.sync.repliesAt'
const CFG_LAST_REPLIES = 'lark.sync.lastReplies'

/** 单批写入条数（Base 批量接口上限 500，这里留余量并给群之间留节奏） */
const BATCH_SIZE = 100
/** 批量之间的间隔（毫秒）：Base 接口有 QPS 限制，串行 + 间隔最稳） */
const BATCH_GAP_MS = 120

/** Base 字段类型码 */
const T_TEXT = 1
const T_NUMBER = 2
const T_SINGLE = 3
const T_DATE = 5

interface FieldSpec {
  name: string
  type: number
  options?: string[]
}

/** 「议题」表字段：带 ✎ 的在 M2 允许同事改（白名单回写），其余以本地为准 */
const ISSUE_FIELDS: FieldSpec[] = [
  { name: '议题ID', type: T_TEXT },
  { name: '客户群', type: T_TEXT },
  {
    name: '类型',
    type: T_SINGLE,
    options: ['客诉', '售后', '物流', '价格', '咨询', '建议', '其他']
  },
  { name: '严重度', type: T_SINGLE, options: ['紧急', '高', '一般'] },
  { name: '标题', type: T_TEXT },
  { name: '摘要', type: T_TEXT },
  { name: '状态', type: T_SINGLE, options: ['待处理', '跟进中', '已解决', '已搁置', '不是问题'] },
  { name: '跟进人', type: T_TEXT },
  { name: '处理备注', type: T_TEXT },
  { name: '首现时间', type: T_DATE },
  { name: '最近更新', type: T_DATE },
  { name: '证据条数', type: T_NUMBER }
]

const REPLY_FIELDS: FieldSpec[] = [
  { name: '回复ID', type: T_TEXT },
  { name: '客户群', type: T_TEXT },
  { name: '触发消息', type: T_TEXT },
  { name: '判定', type: T_SINGLE, options: ['命中话术', 'LLM 兜底', '转人工'] },
  { name: '意图', type: T_TEXT },
  { name: '拟回复', type: T_TEXT },
  { name: '风险', type: T_SINGLE, options: ['A 可自动', 'B 需确认', 'C 禁自动'] },
  { name: '状态', type: T_SINGLE, options: ['影子（待看）', '已采纳', '已驳回'] },
  { name: '人工反馈', type: T_SINGLE, options: ['答得对', '答错了', '不该回'] },
  { name: '时间', type: T_DATE }
]

export interface BaseRef {
  appToken: string
  tableId?: string
}

/** 解析用户粘贴的链接（/base/ 或 /bitable/ 或裸 token） */
export function parseBaseRef(
  input: string
): { ok: true; ref: BaseRef } | { ok: false; error: string } {
  const parsed = parseLarkRef(input)
  if (!parsed)
    return { ok: false, error: '看不懂这个链接：请粘贴多维表格的分享链接（…/base/xxxx）' }
  if (parsed.kind !== 'base') {
    return {
      ok: false,
      error:
        '这不是多维表格链接（多维表格是 …/base/… 或 …/bitable/…）。电子表格(sheets)不支持字段级同步'
    }
  }
  return { ok: true, ref: { appToken: parsed.token, tableId: parsed.tableId } }
}

export function baseConfiguredLink(): string {
  return (getConfig(CFG_TOKEN) ?? '').trim()
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function fieldPayload(spec: FieldSpec): Record<string, unknown> {
  const out: Record<string, unknown> = { field_name: spec.name, type: spec.type }
  if (spec.options && spec.options.length > 0) {
    out.property = { options: spec.options.map((name) => ({ name })) }
  }
  return out
}

/** 找表（按名字）；不存在返回 null */
async function findTable(appToken: string, name: string): Promise<string | null> {
  const r = await larkCall<{
    items?: Array<{ table_id?: string; name?: string }>
    has_more?: boolean
    page_token?: string
  }>((api) =>
    api.bitable.appTable.list({ path: { app_token: appToken }, params: { page_size: 100 } })
  )
  if (!r.ok) throw new Error(r.error)
  const hit = (r.data.items ?? []).find((t) => (t.name ?? '').trim() === name)
  return hit?.table_id ?? null
}

/**
 * 确保表存在且字段齐全：缺表则建（带字段），缺字段则补。
 * 返回 { tableId, created, fieldsAdded }；任何一步失败都抛错（由调用方转成人话）。
 */
async function ensureTable(
  appToken: string,
  name: string,
  fields: FieldSpec[]
): Promise<{ tableId: string; created: boolean; fieldsAdded: string[] }> {
  let tableId = await findTable(appToken, name)
  let created = false
  if (!tableId) {
    const r = await larkCall<{ table_id?: string }>((api) =>
      api.bitable.appTable.create({
        path: { app_token: appToken },
        data: { table: { name, default_view_name: '全部', fields: fields.map(fieldPayload) } }
      })
    )
    if (!r.ok) throw new Error(r.error)
    tableId = r.data.table_id ?? ''
    if (!tableId) throw new Error(`创建数据表「${name}」成功但没有返回 table_id`)
    created = true
  }

  // 字段补齐（新建表时若接口忽略了 fields，这里会补齐；已有表则只加缺的）
  const listed = await larkCall<{ items?: Array<{ field_name?: string }> }>((api) =>
    api.bitable.appTableField.list({
      path: { app_token: appToken, table_id: tableId as string },
      params: { page_size: 100 }
    })
  )
  if (!listed.ok) throw new Error(listed.error)
  const have = new Set((listed.data.items ?? []).map((f) => (f.field_name ?? '').trim()))
  const fieldsAdded: string[] = []
  for (const spec of fields) {
    if (have.has(spec.name)) continue
    const r = await larkCall((api) =>
      api.bitable.appTableField.create({
        path: { app_token: appToken, table_id: tableId as string },
        data: fieldPayload(spec)
      })
    )
    if (!r.ok) {
      // 主字段名不可改/重名等：记录但不致命，后续写入会暴露具体缺哪个字段
      syncLog.warn(`补字段「${spec.name}」失败: ${r.error}`)
      continue
    }
    fieldsAdded.push(spec.name)
    await sleep(BATCH_GAP_MS)
  }
  return { tableId, created, fieldsAdded }
}

export interface BaseVerifyResult {
  ok: boolean
  error?: string
  appToken?: string
  issuesTableId?: string
  repliesTableId?: string
  notes: string[]
}

/**
 * 验证链接 + 建表建字段 + 写一条测试记录再删掉（把「读得到/write 得进」一次说清）。
 * 成功后把 app_token 与两张表 id 落配置，后续同步直接复用。
 */
export async function verifyBaseLink(link: string): Promise<BaseVerifyResult> {
  const notes: string[] = []
  const parsed = parseBaseRef(link)
  if (!parsed.ok) return { ok: false, error: parsed.error, notes }
  const appToken = parsed.ref.appToken

  try {
    const issues = await ensureTable(appToken, ISSUE_TABLE_NAME, ISSUE_FIELDS)
    notes.push(
      issues.created
        ? `已创建数据表「${ISSUE_TABLE_NAME}」`
        : `复用已有数据表「${ISSUE_TABLE_NAME}」`
    )
    if (issues.fieldsAdded.length > 0) notes.push(`议题表补字段: ${issues.fieldsAdded.join('、')}`)
    await sleep(BATCH_GAP_MS)
    const replies = await ensureTable(appToken, REPLY_TABLE_NAME, REPLY_FIELDS)
    notes.push(
      replies.created
        ? `已创建数据表「${REPLY_TABLE_NAME}」`
        : `复用已有数据表「${REPLY_TABLE_NAME}」`
    )
    if (replies.fieldsAdded.length > 0)
      notes.push(`回复表补字段: ${replies.fieldsAdded.join('、')}`)

    // 写测试：真正证明「有写权限」，而不是只读得动
    const created = await larkCall<{ record?: { record_id?: string } }>((api) =>
      api.bitable.appTableRecord.create({
        path: { app_token: appToken, table_id: issues.tableId },
        data: { fields: { 议题ID: '__verify__', 标题: '同步连通性测试（会自动删除）' } }
      })
    )
    if (!created.ok) {
      return {
        ok: false,
        appToken,
        issuesTableId: issues.tableId,
        repliesTableId: replies.tableId,
        error:
          '读得到但写不进：请在开放平台给应用开通多维表格**读写**权限（bitable:app）并发布版本 —— ' +
          created.error,
        notes
      }
    }
    const recordId = created.data.record?.record_id
    notes.push('写入测试记录成功（读写权限 OK）')
    if (recordId) {
      const del = await larkCall((api) =>
        api.bitable.appTableRecord.delete({
          path: { app_token: appToken, table_id: issues.tableId, record_id: recordId }
        })
      )
      notes.push(
        del.ok ? '测试记录已删除' : `测试记录删除失败（请手动删掉「__verify__」那行）: ${del.error}`
      )
    }

    setConfig(CFG_TOKEN, appToken)
    setConfig(CFG_TABLE_ISSUES, issues.tableId)
    setConfig(CFG_TABLE_REPLIES, replies.tableId)
    return {
      ok: true,
      appToken,
      issuesTableId: issues.tableId,
      repliesTableId: replies.tableId,
      notes
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, appToken, error: msg, notes }
  }
}

// ── 议题 → Base ──

// 字段映射（issueToFields / statusText / hashOf 等）在 baseMapping.ts —— 纯函数、可自检

export interface SyncOutResult {
  ok: boolean
  error?: string
  scanned: number
  created: number
  updated: number
  skipped: number
  failed: number
  at: number
}

function readLastResult(): SyncOutResult | null {
  const raw = getConfig(CFG_LAST_RESULT)
  if (!raw) return null
  try {
    return JSON.parse(raw) as SyncOutResult
  } catch {
    return null
  }
}

function readLastReplies(): SyncOutResult | null {
  const raw = getConfig(CFG_LAST_REPLIES)
  if (!raw) return null
  try {
    return JSON.parse(raw) as SyncOutResult
  } catch {
    return null
  }
}

function readLastPull(): PullResult | null {
  const raw = getConfig(CFG_LAST_PULL)
  if (!raw) return null
  try {
    return JSON.parse(raw) as PullResult
  } catch {
    return null
  }
}

export interface BaseSyncStatus {
  configured: boolean
  appToken?: string
  issuesTableId?: string
  repliesTableId?: string
  enabled: boolean
  rawEvidence: boolean
  lastAt: number
  mappedIssues: number
  mappedReplies: number
  lastResult: SyncOutResult | null
  lastPull: PullResult | null
  /** 数字员工回复（影子记录）最近一次推送结果 */
  lastReplies: SyncOutResult | null
}

export function baseSyncStatus(): BaseSyncStatus {
  return {
    configured: !!baseConfiguredLink(),
    appToken: baseConfiguredLink() || undefined,
    issuesTableId: (getConfig(CFG_TABLE_ISSUES) ?? '').trim() || undefined,
    repliesTableId: (getConfig(CFG_TABLE_REPLIES) ?? '').trim() || undefined,
    enabled: getConfigBoolean(CFG_SYNC_ENABLED, false),
    rawEvidence: getConfigBoolean(CFG_RAW_EVIDENCE, false),
    lastAt: Number(getConfig(CFG_LAST_AT) ?? 0) || 0,
    mappedIssues: countSyncRefs('issue'),
    mappedReplies: countSyncRefs('reply'),
    lastResult: readLastResult(),
    lastPull: readLastPull(),
    lastReplies: readLastReplies()
  }
}

export function setSyncEnabled(on: boolean): void {
  setConfig(CFG_SYNC_ENABLED, on ? '1' : '0')
}

export function setRawEvidence(on: boolean): void {
  setConfig(CFG_RAW_EVIDENCE, on ? '1' : '0')
}

/**
 * 议题单向同步（只出不进）。force=true 时忽略上次同步时间，全量核对一遍。
 * 写失败不中断整轮：单条失败计数并继续，避免一条坏数据卡住后面所有议题。
 */
export async function syncIssuesOut(
  wxid: string,
  opts: { force?: boolean } = {}
): Promise<SyncOutResult> {
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
  const appToken = baseConfiguredLink()
  if (!appToken) return { ...empty, error: '未配置多维表格链接（设置 → 飞书云文档 → 议题同步）' }
  let tableId = (getConfig(CFG_TABLE_ISSUES) ?? '').trim()
  if (!tableId) {
    const verified = await verifyBaseLink(appToken)
    if (!verified.ok) return { ...empty, error: verified.error ?? '建表失败' }
    tableId = verified.issuesTableId ?? ''
  }
  if (!tableId) return { ...empty, error: '未解析出议题表 id，请重新点「验证并建表」' }

  const since = opts.force ? 0 : Number(getConfig(CFG_LAST_AT) ?? 0) || 0
  const rows = listIssuesChangedSince(wxid, since)
  const names = new Map(listTeamMembers(wxid).map((m) => [m.username, m.label || m.username]))
  const out: SyncOutResult = {
    ok: true,
    scanned: rows.length,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    at
  }

  // 待新建的攒批；待更新的逐条（Base 单条更新更稳，量也不大）
  let pendingCreates: Array<{ id: number; fields: Record<string, unknown>; hash: string }> = []

  const flushCreates = async (): Promise<void> => {
    if (pendingCreates.length === 0) return
    const batch = pendingCreates
    pendingCreates = []
    const r = await larkCall<{ records?: Array<{ record_id?: string }> }>((api) =>
      api.bitable.appTableRecord.batchCreate({
        path: { app_token: appToken, table_id: tableId },
        data: { records: batch.map((b) => ({ fields: b.fields })) }
      })
    )
    if (!r.ok) {
      out.failed += batch.length
      syncLog.warn(`批量新增议题失败 ${batch.length} 条: ${r.error}`)
      return
    }
    const records = r.data.records ?? []
    batch.forEach((b, idx) => {
      const recordId = records[idx]?.record_id
      if (!recordId) {
        out.failed++
        return
      }
      saveSyncRef('issue', b.id, appToken, tableId, recordId, b.hash, {
        status: String(b.fields['状态'] ?? ''),
        assignee: String(b.fields['跟进人'] ?? ''),
        pushed: true
      })
      out.created++
    })
    await sleep(BATCH_GAP_MS)
  }

  for (const issue of rows) {
    const fields = issueToFields(issue, names)
    const hash = hashOf(fields)
    const ref = getSyncRef('issue', issue.id)
    if (!ref) {
      pendingCreates.push({ id: issue.id, fields, hash })
      if (pendingCreates.length >= BATCH_SIZE) await flushCreates()
      continue
    }
    if (ref.contentHash === hash && ref.tableId === tableId) {
      out.skipped++
      continue
    }
    const r = await larkCall((api) =>
      api.bitable.appTableRecord.update({
        path: { app_token: appToken, table_id: tableId, record_id: ref.recordId },
        data: { fields }
      })
    )
    if (!r.ok) {
      // 记录被同事删了/表换了：清掉映射，下一轮按新建处理
      if (/not.?found|record.?id|1254/i.test(r.error)) {
        saveSyncRef('issue', issue.id, appToken, tableId, ref.recordId, '')
        pendingCreates.push({ id: issue.id, fields, hash })
        continue
      }
      out.failed++
      syncLog.warn(`更新议题 #${issue.id} 失败: ${r.error}`)
      continue
    }
    saveSyncRef('issue', issue.id, appToken, tableId, ref.recordId, hash, {
      status: String(fields['状态'] ?? ''),
      assignee: String(fields['跟进人'] ?? ''),
      pushed: true
    })
    out.updated++
    await sleep(BATCH_GAP_MS)
  }
  await flushCreates()

  setConfig(CFG_LAST_AT, String(at))
  setConfig(CFG_LAST_RESULT, JSON.stringify(out))
  if (out.failed > 0) out.ok = false
  return out
}

// ── Base → 本地（回写）──

/**
 * 从 Base 拉回同事的改动（状态 / 跟进人）。
 *
 * 判定「是不是同事改的」：拿 Base 现值与 `lark_sync_map.remote_*`（**上次同步时 Base 上的值**）比对，
 * 不同即认定是人在表格里动的 —— 否则我们自己刚写上去的值会被误判成同事改的，来回打架。
 *
 * 冲突规则（**本地权威**）：若本地行的 updated_at 晚于我们上次推送时间（pushed_at），说明本地也动了，
 * 这一轮不采纳对方的值（下一轮推送会把本地值写回 Base）；否则采纳。
 */
export interface PullResult {
  ok: boolean
  error?: string
  /** Base 里读到的记录数 */
  scanned: number
  /** 采纳并应用到本地的条数 */
  applied: number
  /** 冲突：本地更新更晚，保留本地 */
  skippedLocalWin: number
  /** 认不出来的行（找不到本地议题 / 状态文案不认） */
  unmatched: number
  at: number
}

interface RemoteRecord {
  recordId: string
  fields: Record<string, unknown>
}

/** 读取议题表里我们关心的三列（分页；field_names 只取必要的，减少流量与限流压力） */
async function listIssueRecords(appToken: string, tableId: string): Promise<RemoteRecord[]> {
  const out: RemoteRecord[] = []
  let pageToken: string | undefined
  for (let page = 0; page < 20; page += 1) {
    const r = await larkCall<{
      items?: Array<{ record_id?: string; fields?: Record<string, unknown> }>
      has_more?: boolean
      page_token?: string
    }>((api) =>
      api.bitable.appTableRecord.list({
        path: { app_token: appToken, table_id: tableId },
        params: {
          page_size: 200,
          field_names: JSON.stringify(['议题ID', '状态', '跟进人', '处理备注']),
          ...(pageToken ? { page_token: pageToken } : {})
        }
      })
    )
    if (!r.ok) throw new Error(r.error)
    for (const it of r.data.items ?? []) {
      if (it.record_id) out.push({ recordId: it.record_id, fields: it.fields ?? {} })
    }
    if (!r.data.has_more || !r.data.page_token) break
    pageToken = r.data.page_token
  }
  return out
}

export async function pullIssuesBack(wxid: string): Promise<PullResult> {
  const at = Date.now()
  const empty: PullResult = {
    ok: false,
    scanned: 0,
    applied: 0,
    skippedLocalWin: 0,
    unmatched: 0,
    at
  }
  const appToken = baseConfiguredLink()
  if (!appToken) return { ...empty, error: '未配置多维表格链接' }
  const tableId = (getConfig(CFG_TABLE_ISSUES) ?? '').trim()
  if (!tableId) return { ...empty, error: '未解析出议题表 id' }

  let records: RemoteRecord[]
  try {
    records = await listIssueRecords(appToken, tableId)
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : String(e) }
  }

  const refs = new Map(listSyncRefs('issue').map((r) => [r.localId, r]))
  const members = listTeamMembers(wxid).map((m) => ({ username: m.username, label: m.label ?? '' }))
  const out: PullResult = {
    ok: true,
    scanned: records.length,
    applied: 0,
    skippedLocalWin: 0,
    unmatched: 0,
    at
  }

  for (const rec of records) {
    const idText = String(rec.fields['议题ID'] ?? '').trim()
    const localId = Number.parseInt(idText, 10)
    if (!Number.isFinite(localId)) {
      out.unmatched++
      continue
    }
    const ref = refs.get(localId)
    if (!ref) {
      out.unmatched++
      continue
    }
    const remote = collabOf(rec.fields)
    const diff = diffCollab(remote, {
      status: ref.remoteStatus,
      assignee: ref.remoteAssignee,
      note: ref.remoteNote
    })
    if (!diff.any) continue

    const local = getIssueById(localId)
    if (!local) {
      out.unmatched++
      continue
    }
    // 冲突：本地更新时间晚于我们上次推送 → 本地赢（下一轮推送把本地值写回 Base）
    if (ref.pushedAt && local.updatedAt > ref.pushedAt) {
      out.skippedLocalWin++
      saveRemoteCollab('issue', localId, remote)
      continue
    }

    let okApply = true
    if (diff.statusChanged) {
      const status = statusFromText(remote.status)
      if (!status) {
        okApply = false
        syncLog.warn(`议题 #${localId} 的状态值「${remote.status}」不认识，已跳过`)
      } else if (status !== local.status) {
        setIssueStatus(localId, status, false)
      }
    }
    if (diff.assigneeChanged) {
      const next = assigneeFromText(remote.assignee, members)
      if (next !== (local.assignee ?? null)) setIssueAssignee(localId, next)
    }
    if (diff.noteChanged) {
      const nextNote = remote.note.slice(0, 500)
      if (nextNote !== (local.note ?? '')) setIssueNote(localId, nextNote || null)
    }
    if (okApply) out.applied++
    else out.unmatched++
    saveRemoteCollab('issue', localId, remote)
    await sleep(BATCH_GAP_MS)
  }

  setConfig(CFG_LAST_PULL, JSON.stringify(out))
  return out
}

// ── 数字员工回复（影子记录）→ Base ──

/**
 * 把影子/待审回复推到「数字员工回复」表：手机上就能审话术（答得对/答错了/不该回）。
 * 与议题同步同样的幂等策略（映射表 + 内容 hash 跳过），触发消息默认截断 120 字。
 */
export async function syncRepliesOut(
  wxid: string,
  opts: { force?: boolean } = {}
): Promise<SyncOutResult> {
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
  const appToken = baseConfiguredLink()
  if (!appToken) return { ...empty, error: '未配置多维表格链接' }
  let tableId = (getConfig(CFG_TABLE_REPLIES) ?? '').trim()
  if (!tableId) {
    const verified = await verifyBaseLink(appToken)
    if (!verified.ok) return { ...empty, error: verified.error ?? '建表失败' }
    tableId = verified.repliesTableId ?? ''
  }
  if (!tableId) return { ...empty, error: '未解析出回复表 id，请重新点「验证并建表」' }

  const since = opts.force ? 0 : Number(getConfig(CFG_LAST_REPLIES_AT) ?? 0) || 0
  const rows = listRepliesChangedSince(wxid, since)
  const out: SyncOutResult = {
    ok: true,
    scanned: rows.length,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    at
  }
  const triggerChars = getConfigBoolean(CFG_RAW_EVIDENCE, false) ? 500 : 120

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
      syncLog.warn(`批量新增回复失败 ${batch.length} 条: ${r.error}`)
      return
    }
    const records = r.data.records ?? []
    batch.forEach((b, idx) => {
      const recordId = records[idx]?.record_id
      if (!recordId) {
        out.failed++
        return
      }
      saveSyncRef('reply', b.id, appToken, tableId, recordId, b.hash, {
        status: '',
        assignee: '',
        pushed: true
      })
      out.created++
    })
    await sleep(BATCH_GAP_MS)
  }

  for (const row of rows) {
    const fields = replyToFields(row, triggerChars)
    const hash = hashOf(fields)
    const ref = getSyncRef('reply', row.id)
    if (!ref) {
      pending.push({ id: row.id, fields, hash })
      if (pending.length >= BATCH_SIZE) await flush()
      continue
    }
    if (ref.contentHash === hash && ref.tableId === tableId) {
      out.skipped++
      continue
    }
    const r = await larkCall((api) =>
      api.bitable.appTableRecord.update({
        path: { app_token: appToken, table_id: tableId, record_id: ref.recordId },
        data: { fields }
      })
    )
    if (!r.ok) {
      if (/not.?found|record.?id|1254/i.test(r.error)) {
        dropSyncRef('reply', row.id)
        pending.push({ id: row.id, fields, hash })
        continue
      }
      out.failed++
      syncLog.warn(`更新回复 #${row.id} 失败: ${r.error}`)
      continue
    }
    saveSyncRef('reply', row.id, appToken, tableId, ref.recordId, hash, {
      status: '',
      assignee: '',
      pushed: true
    })
    out.updated++
    await sleep(BATCH_GAP_MS)
  }
  await flush()

  setConfig(CFG_LAST_REPLIES_AT, String(at))
  setConfig(CFG_LAST_REPLIES, JSON.stringify(out))
  if (out.failed > 0) out.ok = false
  return out
}

/** 给 UI 的一句话状态 */
export function baseSyncHint(): string {
  const st = baseSyncStatus()
  if (!st.configured) return '未配置：粘贴多维表格链接后点「验证并建表」'
  if (!st.enabled) return '已配置但同步开关关闭'
  const r = st.lastResult
  if (!r) return '已配置，尚未同步过'
  const when = new Date(r.at).toLocaleString('zh-CN')
  const p = st.lastPull
  const pullText = p
    ? ` · 拉回同事改动 ${p.applied}${p.skippedLocalWin ? `（${p.skippedLocalWin} 条本地更新更晚，保留本地）` : ''}`
    : ''
  const rep = st.lastReplies
  const repText = rep ? ` · 影子记录 ${rep.created + rep.updated} 条` : ''
  return `最近同步 ${when}：新增 ${r.created} · 更新 ${r.updated} · 跳过 ${r.skipped}${r.failed ? ` · 失败 ${r.failed}` : ''}${r.error ? ` · ${r.error}` : ''}${pullText}${repText}`
}

export { larkErrorHint }
