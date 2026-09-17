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

import { getConfig, getConfigBoolean, setConfig } from '../../db/repos/config'
import {
  countSyncRefs,
  invalidateSyncHashes,
  dropSyncRef,
  getSyncRef,
  listSyncRefs,
  saveRemoteCollab,
  saveSyncRef,
  setSyncRefUid
} from '../../db/repos/larkSyncRepo'
import {
  getIssueById,
  listIssues,
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
  issueUid,
  mapFieldName,
  replyToFields,
  statusFromText,
  UID_FIELD,
  FieldMap
} from './baseMapping'
import { countAttached, countMediaRefs } from '../../db/repos/larkMediaRepo'
import {
  getPersonConfig,
  openIdOf,
  personMapStale,
  refreshPersonMap,
  PersonConfig
} from './personMap'
import { fmtStamp } from '../../../shared/monitorMetrics'
import { createLogger } from '../logging'
import {
  CFG_TABLE_ISSUES,
  CFG_TABLE_REPLIES,
  CFG_SYNC_ENABLED,
  CFG_RAW_EVIDENCE,
  CFG_LAST_AT,
  CFG_LAST_RESULT,
  CFG_LAST_PULL,
  CFG_LAST_REPLIES_AT,
  CFG_LAST_REPLIES,
  CFG_HISTORY,
  CFG_BASE_NAME,
  CFG_TABLE_ISSUES_NAME,
  CFG_BASE_LINK,
  CFG_CAN_WRITE_BACK,
  COLLAB_KEYS,
  BATCH_SIZE,
  BATCH_GAP_MS,
  REPLY_FIELDS,
  baseConfiguredLink,
  getFieldMap,
  getPrimaryField,
  getConflictedFields,
  canWriteBack,
  pushHistory,
  sleep,
  listFields,
  ensureFields,
  isRecordMissingError,
  type SyncOutResult,
  type PullResult
} from './baseCore'
import {
  countPendingEvidence,
  readLastEvidence,
  getEvidenceConfig,
  type EvidenceConfig
} from './baseEvidence'

const syncLog = createLogger('lark')

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
  /** UI 展示用链接(优先用户当初粘贴的完整链接) */
  link?: string
  /** 同事能否回写(三列齐全) */
  canWriteBack: boolean
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
  /** 主字段名(标题写入这一列) */
  primaryField: string
  /** 列名映射(本地标准列名 → 目标表列名) */
  fieldMap: FieldMap
  /** 目标表是否有同事回写过(最近一轮拉取的说明) */
  pullNote?: string
  /** 最近若干轮结果(kind + 概要),供设置页/监控页展示 */
  history: Array<Record<string, unknown>>
  /** 证据明细同步配置(开关 / 天数 / 每议题条数 / 每条字数 / 子表 id) */
  evidence: EvidenceConfig
  /** 已推证据条数 */
  mappedEvidence: number
  /** 证据最近一次推送结果 */
  lastEvidence: SyncOutResult | null
  /** 按当前上限,本轮还会推几条证据(0 = 已追平) */
  pendingEvidence: number
  /** 已上传到 Base 的证据图片素材数(按 md5 去重) */
  mappedMedia: number
  /** 已写进证据行的附件条数(≤ mappedMedia,同一张图可被多条证据复用) */
  attachedEvidence: number
  /** 多维表格名(验证时记下,UI 显示用) */
  baseName: string
  /** 议题表名(链接指定的那张,或自动建的「议题」) */
  issuesTableName: string
  /** 人员列(飞书成员)配置与映射状态 */
  person: PersonConfig
}

export function baseSyncStatus(): BaseSyncStatus {
  return {
    configured: !!baseConfiguredLink(),
    // link 给 UI 用:优先回显用户当初粘贴的完整链接(裸 token 对用户没有意义)
    link: (getConfig(CFG_BASE_LINK) ?? '').trim() || baseConfiguredLink() || undefined,
    canWriteBack: getConfigBoolean(CFG_CAN_WRITE_BACK, false),
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
    lastReplies: readLastReplies(),
    primaryField: getPrimaryField(),
    fieldMap: getFieldMap(),
    pullNote: readLastPull()?.note,
    history: readHistory(),
    evidence: getEvidenceConfig(),
    mappedEvidence: countSyncRefs('evidence'),
    lastEvidence: readLastEvidence(),
    pendingEvidence: countPendingEvidence(),
    mappedMedia: countMediaRefs(),
    attachedEvidence: countAttached(),
    baseName: (getConfig(CFG_BASE_NAME) ?? '').trim(),
    issuesTableName: (getConfig(CFG_TABLE_ISSUES_NAME) ?? '').trim(),
    person: getPersonConfig()
  }
}

/** 最近同步历史(最新的在前,最多 20 条) */
function readHistory(): Array<Record<string, unknown>> {
  const raw = (getConfig(CFG_HISTORY) ?? '').trim()
  if (!raw) return []
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? (v as Array<Record<string, unknown>>).slice(0, 20) : []
  } catch {
    return []
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
  const tableId = (getConfig(CFG_TABLE_ISSUES) ?? '').trim()
  // 与回复表一致:不在同步里隐式建表(避免"同步一下结果多出一张表"的意外副作用)
  if (!tableId) {
    return {
      ...empty,
      error: '尚未确定议题表:请先在设置页点「执行并建表」(或监控页「同步到飞书」配置)'
    }
  }

  const since = opts.force ? 0 : Number(getConfig(CFG_LAST_AT) ?? 0) || 0
  const rows = listIssuesChangedSince(wxid, since)
  const names = new Map(listTeamMembers(wxid).map((m) => [m.username, m.label || m.username]))
  // 列名映射 + 主字段:目标表可能是用户自己的表(列名不同 / 第一列是主字段)
  const fieldMap = getFieldMap()
  const primaryField = getPrimaryField()
  const colOf = (local: string): string => mapFieldName(local, fieldMap)
  // 类型不符的列直接不写:否则飞书会整条记录拒收 → 该议题永远同步不进去
  const conflicts = new Set(getConflictedFields())
  if (conflicts.has(colOf('议题ID'))) {
    return {
      ...empty,
      error: `列「${colOf('议题ID')}」类型不符(需要文本),无法建立映射:请在飞书里把它改成文本列,或在设置页做列名映射`
    }
  }
  // 议题UID（跨机器稳定 ID）：新表由「执行并建表」自动带上；老表 / 用户自建表可能没有。
  // 写一个不存在的列会让飞书**整条记录拒收**（同类坑实测 58 条全失败），所以先探测再决定写不写；
  // 探测失败就当作没有 —— 本轮的匹配退回按行号，与升级前行为一致，不会更差。
  const uidCol = colOf(UID_FIELD)
  let hasUidCol = false
  try {
    hasUidCol = (await listFields(appToken, tableId)).some((f) => f.name === uidCol)
  } catch {
    hasUidCol = false
  }
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
  let pendingCreates: Array<{
    id: number
    fields: Record<string, unknown>
    hash: string
    uid: string
  }> = []

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
        status: String(b.fields[colOf('状态')] ?? ''),
        assignee: String(b.fields[colOf('跟进人')] ?? ''),
        uid: b.uid,
        pushed: true
      })
      out.created++
    })
    await sleep(BATCH_GAP_MS)
  }

  // 人员列:开启映射时,若映射过期顺手刷一次(一天一次,失败不影响同步)
  const person = getPersonConfig()
  if (person.enabled && personMapStale()) {
    const r2 = await refreshPersonMap()
    if (r2.ok) syncLog.info(`人员映射已刷新: ${r2.mapped} 人`)
    else syncLog.warn(`人员映射刷新失败(人员列本轮留空): ${r2.error ?? ''}`)
  }

  for (const issue of rows) {
    const personName = person.enabled ? (issue.assignee ?? '').trim() : ''
    const personField =
      personName && openIdOf(personName)
        ? { name: person.field, openId: openIdOf(personName) }
        : undefined
    const fields = issueToFields(issue, names, { fieldMap, primaryField, personField })
    if (!hasUidCol) delete fields[uidCol]
    if (conflicts.size > 0) {
      for (const k of Object.keys(fields)) if (conflicts.has(k)) delete fields[k]
      out.skippedFields = (out.skippedFields ?? 0) + 1
    }
    const hash = hashOf(fields)
    // 记进映射表：拉取时用「Base 记录的议题UID → 本地行」对齐，不再依赖本地自增行号
    const uid = hasUidCol && !conflicts.has(uidCol) ? issueUid(issue.wxid, issue.key) : ''
    const ref = getSyncRef('issue', issue.id)
    if (!ref) {
      pendingCreates.push({ id: issue.id, fields, hash, uid })
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
      // 记录被同事删了/表换了：清掉映射，下一轮按新建处理。
      // 判定要窄（字段类错误码同样是 1254xxx，误判会导致重复插入）：见 baseCore.isRecordMissingError。
      if (isRecordMissingError(r.error)) {
        saveSyncRef('issue', issue.id, appToken, tableId, ref.recordId, '')
        pendingCreates.push({ id: issue.id, fields, hash, uid })
        continue
      }
      out.failed++
      syncLog.warn(`更新议题 #${issue.id} 失败: ${r.error}`)
      continue
    }
    saveSyncRef('issue', issue.id, appToken, tableId, ref.recordId, hash, {
      status: String(fields[colOf('状态')] ?? ''),
      assignee: String(fields[colOf('跟进人')] ?? ''),
      uid,
      pushed: true
    })
    out.updated++
    await sleep(BATCH_GAP_MS)
  }
  await flushCreates()

  setConfig(CFG_LAST_AT, String(at))
  setConfig(CFG_LAST_RESULT, JSON.stringify(out))
  if (out.failed > 0) out.ok = false
  pushHistory('issue', out)
  return out
}

export interface ClaimResult {
  ok: boolean
  error?: string
  /** 目标表里读到的行数 */
  scanned: number
  /** 本次认领(建立映射)的行数 */
  claimed: number
  /** 已有映射、无需认领 */
  already: number
  /** 目标表里有行但本地找不到对应议题（例如历史清理过） */
  unmatched: number
}

/**
 * 认领既有行：目标表本来就是用户的表，里面可能已经有行（他们手工写的，或换表前的历史）。
 *
 * 对齐顺序：**先按「议题UID」（跨机器稳定）**，认不出才退回「议题ID」（本地行号）。
 * 只按行号认领在多机器共用一张表时会认错人 —— 两台机器的行号各自从 1 开始，
 * 于是把 B 机的议题钉到 A 机的记录上，之后同事的处置全写错议题。
 *
 * 不写入协作列的上次已知值 —— 让首轮拉取能把同事已填的状态/跟进人带进本地。
 */
export async function claimExistingRecords(
  appToken: string,
  tableId: string,
  wxid = ''
): Promise<ClaimResult> {
  const out: ClaimResult = { ok: false, scanned: 0, claimed: 0, already: 0, unmatched: 0 }
  const map = getFieldMap()
  const idCol = mapFieldName('议题ID', map)
  const uidCol = mapFieldName(UID_FIELD, map)
  const fields = await listFields(appToken, tableId).catch(() => [])
  const hasUidCol = fields.some((f) => f.name === uidCol)
  const records = await listIssueRecords(appToken, tableId, [idCol, ...(hasUidCol ? [uidCol] : [])])
  // 本机全部议题的「稳定 ID → 行号」表：用它把 Base 行认回本地，而不是信行号
  const uidToLocal = new Map<string, number>()
  if (hasUidCol && wxid) {
    for (const it of listIssues(wxid)) uidToLocal.set(issueUid(it.wxid, it.key), it.id)
  }
  out.scanned = records.length
  for (const rec of records) {
    const uid = hasUidCol ? String(rec.fields[uidCol] ?? '').trim() : ''
    const byUid = uid ? uidToLocal.get(uid) : undefined
    const idText = String(rec.fields[idCol] ?? '').trim()
    const localId = byUid ?? Number.parseInt(idText, 10)
    if (!Number.isFinite(localId) || !getIssueById(localId)) {
      out.unmatched++
      continue
    }
    const ref = getSyncRef('issue', localId)
    if (ref && ref.recordId === rec.recordId) {
      if (uid) setSyncRefUid('issue', localId, uid)
      out.already++
      continue
    }
    // contentHash 留空 → 下一轮推送会补写程序列(把我们的列填上);协作列留给首轮拉取
    saveSyncRef('issue', localId, appToken, tableId, rec.recordId, '', { uid })
    out.claimed++
  }
  out.ok = true
  return out
}

interface RemoteRecord {
  recordId: string
  fields: Record<string, unknown>
}

/** 读取议题表里我们关心的三列（分页；field_names 只取必要的，减少流量与限流压力） */
async function listIssueRecords(
  appToken: string,
  tableId: string,
  fieldNames: string[] = ['议题ID', '状态', '跟进人', '处理备注']
): Promise<RemoteRecord[]> {
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
          field_names: JSON.stringify(fieldNames),
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

  const map = getFieldMap()
  const idCol = mapFieldName('议题ID', map)
  const uidCol = mapFieldName(UID_FIELD, map)
  let hasUidCol = false
  // 回写闸门:目标表没有 状态/跟进人/处理备注 三列时,同步退化为单向(不再报错刷日志)
  try {
    const have = (await listFields(appToken, tableId)).map((f) => f.name)
    hasUidCol = have.includes(uidCol)
    const conflicted = new Set(getConflictedFields())
    const collabBlocked = COLLAB_KEYS.some((k) => conflicted.has(mapFieldName(k, map)))
    if (collabBlocked) {
      const skipped: PullResult = {
        ...empty,
        ok: true,
        note: '回写列(状态/跟进人/处理备注)存在类型不符,已跳过回写（同步为单向;请改列类型或做列名映射）',
        at
      }
      setConfig(CFG_LAST_PULL, JSON.stringify(skipped))
      pushHistory('pull', skipped)
      return skipped
    }
    if (!canWriteBack(have)) {
      const skipped: PullResult = {
        ...empty,
        ok: true,
        note: '目标表缺少「状态/跟进人/处理备注」列,本轮跳过回写（同步为单向）',
        at
      }
      setConfig(CFG_LAST_PULL, JSON.stringify(skipped))
      pushHistory('pull', skipped)
      return skipped
    }
  } catch {
    /* 列表失败不拦:继续按既有流程拉取,由后续调用报错 */
  }

  let records: RemoteRecord[]
  try {
    records = await listIssueRecords(appToken, tableId, [
      idCol,
      ...(hasUidCol ? [uidCol] : []),
      mapFieldName('状态', map),
      mapFieldName('跟进人', map),
      mapFieldName('处理备注', map)
    ])
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : String(e) }
  }

  const refList = listSyncRefs('issue')
  const refs = new Map(refList.map((r) => [r.localId, r]))
  // 稳定 ID → 本地映射：多机器共用一张表时靠它对齐。
  // 升级前建立的映射 remoteUid 为空，会走下面的行号兜底（并在命中后补写 uid）。
  const uidRefs = new Map(refList.filter((r) => r.remoteUid).map((r) => [r.remoteUid, r] as const))
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
    // 优先用 Base 的 议题UID 对齐：本地自增行号在多机器共用一张表时会撞车
    // （A 机的 #12 与 B 机的 #12 是不同议题），撞了就会把同事的处置写到别人的议题上。
    const uid = hasUidCol ? String(rec.fields[uidCol] ?? '').trim() : ''
    const byUid = uid ? uidRefs.get(uid) : undefined
    const idText = String(rec.fields[idCol] ?? '').trim()
    const localId = byUid ? byUid.localId : Number.parseInt(idText, 10)
    if (!Number.isFinite(localId)) {
      out.unmatched++
      continue
    }
    const ref = byUid ?? refs.get(localId)
    if (!ref) {
      out.unmatched++
      continue
    }
    // 这条 Base 行带稳定 ID、而映射还没有：顺手补上，下一轮起就不必再退回行号匹配
    if (uid && !ref.remoteUid) {
      setSyncRefUid('issue', ref.localId, uid)
      ref.remoteUid = uid
      uidRefs.set(uid, ref)
    }
    const remote = collabOf(rec.fields, map)
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
  pushHistory('pull', out)
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
  const tableId = (getConfig(CFG_TABLE_REPLIES) ?? '').trim()
  // 不再隐式调用 verifyBaseLink:裸 token 进去会"顺手"新建一张「议题」表(用户没同意的副作用)
  if (!tableId) {
    return { ...empty, error: '尚未创建「数字员工回复」表:请在设置页点「执行并建表」后再同步' }
  }

  // 列补齐:回复表的列由我们维护(「意图来源」等是后加的),同步前先确保存在 ——
  // 少一列会让整条记录被飞书拒收(实测 58 条全失败),宁可每轮多一次 listFields。
  try {
    const ensured = await ensureFields(appToken, tableId, REPLY_FIELDS)
    const added = ensured.added ?? []
    if (added.length > 0) {
      // 刚建的列:当轮写入可能被飞书忽略,而我们的内容 hash 已经记下了 → 之后一直跳过。
      // 所以补列后主动作废 hash,让下一轮把每条记录重写一遍,把新列填上。
      const n = invalidateSyncHashes('reply')
      syncLog.info('回复表补列 ' + added.join('、') + ';已作废 ' + n + ' 条内容 hash 以便重写')
      await sleep(800)
    }
  } catch (e) {
    syncLog.warn('回复表补列失败(继续同步): ' + (e instanceof Error ? e.message : String(e)))
  }

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
      // 只有「记录真的没了」才丢映射重新建（历史事故：过宽的 /1254/ 让 58 条变 116 条）。
      if (isRecordMissingError(r.error)) {
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
  pushHistory('reply', out)
  return out
}

/** 给 UI 的一句话状态 */
export function baseSyncHint(): string {
  const st = baseSyncStatus()
  if (!st.configured) return '未配置：粘贴多维表格链接后点「验证并建表」'
  if (!st.enabled) return '已配置但同步开关关闭'
  const r = st.lastResult
  if (!r) return '已配置，尚未同步过'
  const when = fmtStamp(r.at)
  const p = st.lastPull
  const pullText = p
    ? ` · 拉回同事改动 ${p.applied}${p.skippedLocalWin ? `（${p.skippedLocalWin} 条本地更新更晚，保留本地）` : ''}`
    : ''
  const rep = st.lastReplies
  const repText = rep ? ` · 影子记录 ${rep.created + rep.updated} 条` : ''
  return `最近同步 ${when}：新增 ${r.created} · 更新 ${r.updated} · 跳过 ${r.skipped}${r.failed ? ` · 失败 ${r.failed}` : ''}${r.error ? ` · ${r.error}` : ''}${pullText}${repText}`
}

export { larkErrorHint }

// ── 对外导出 ──
// 实现已拆到 baseCore / baseEvidence,这里转发保持原有模块表面(调用方仍可从 baseSync 导入)。
export type { FieldMap } from './baseCore'
export {
  ISSUE_TABLE_NAME,
  REPLY_TABLE_NAME,
  EVIDENCE_TABLE_NAME,
  parseBaseRef,
  baseConfiguredLink,
  getFieldMap,
  setFieldMap,
  getPrimaryField,
  getConflictedFields,
  canWriteBack,
  verifyBaseLink
} from './baseCore'
export type {
  BaseRef,
  BaseVerifyResult,
  VerifyOptions,
  SyncOutResult,
  PullResult
} from './baseCore'
export {
  resetEvidenceMedia,
  getEvidenceConfig,
  setEvidenceConfig,
  ensureEvidenceTable,
  syncEvidenceOut,
  cleanOrphanEvidence
} from './baseEvidence'
export type { EvidenceConfig } from './baseEvidence'
