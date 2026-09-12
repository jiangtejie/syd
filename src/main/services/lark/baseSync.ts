import { getConfig, getConfigBoolean, setConfig } from '../../db/repos/config'
import {
  clearSyncRefs,
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
  evidenceToFields,
  hashOf,
  issueToFields,
  mapFieldName,
  replyToFields,
  statusFromText,
  type FieldMap
} from './baseMapping'
import { listEvidenceForSync, listEvidenceIds } from '../../db/repos/issueRepo'
import {
  countAttached,
  countMediaRefs,
  clearAttached,
  clearMediaRefs,
  hasAttached,
  markAttached
} from '../../db/repos/larkMediaRepo'
import { uploadEvidenceImage } from './mediaUpload'
import {
  DEFAULT_MAX_MEDIA_MB,
  DEFAULT_MAX_UPLOADS_PER_ROUND,
  attachmentFieldValue,
  imageMd5Of,
  isEvidenceImage
} from './evidenceMedia'
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
export const EVIDENCE_TABLE_NAME = '议题证据'

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

/** 列名映射类型(转发自 baseMapping,便于调用方一处导入) */
export type { FieldMap }
/** 列名映射（本地标准列名 → 目标表实际列名） */
const CFG_FIELD_MAP = 'lark.fieldMap'
/** 目标表主字段名（飞书第一列；同步时把标题写进去） */
const CFG_PRIMARY_FIELD = 'lark.primaryField'
/** 最近若干轮同步结果（可观测） */
const CFG_HISTORY = 'lark.sync.history'
/** 类型不符的列名:同步时跳过这些列(避免整条记录写入被拒) */
const CFG_CONFLICTS = 'lark.fieldConflicts'

/* ── 议题证据明细同步(默认关闭:客户原文外发,保守优先) ── */
const CFG_EV_ENABLED = 'lark.evidence.enabled'
/** 收集范围(天,默认 7) */
const CFG_EV_DAYS = 'lark.evidence.days'
/** 每议题最多推几条(默认 20:首现 1 条 + 最新若干) */
const CFG_EV_MAX_PER_ISSUE = 'lark.evidence.maxPerIssue'
/** 每条内容截断字数(默认 200) */
const CFG_EV_MAX_CHARS = 'lark.evidence.maxChars'
/** Base 名与议题表名(验证时记下来,给 UI 显示人话,不显示 token) */
const CFG_BASE_NAME = 'lark.baseName'
const CFG_TABLE_ISSUES_NAME = 'lark.baseTableIssuesName'
/** 用户当初粘贴的完整链接(重新配置时回填;UI 默认只在「高级信息」里露出) */
const CFG_BASE_LINK = 'lark.baseLink'
/** 同事能不能回写(状态/跟进人/处理备注三列齐全) */
const CFG_CAN_WRITE_BACK = 'lark.canWriteBack'
const CFG_EV_MEDIA = 'lark.evidence.media'
const CFG_EV_MAX_MB = 'lark.evidence.maxMediaMB'
const CFG_EV_MAX_UPLOADS = 'lark.evidence.maxUploadsPerRound'
const CFG_EV_TABLE = 'lark.baseTableEvidence'
const CFG_EV_LINK = 'lark.evidence.linkField'
const CFG_EV_LAST_AT = 'lark.sync.evidenceAt'
const CFG_EV_LAST = 'lark.sync.lastEvidence'
const DAY_MS = 24 * 60 * 60 * 1000

/** 可回写的三列（本地列名） */
const COLLAB_KEYS = ['状态', '跟进人', '处理备注'] as const

/** 单批写入条数（Base 批量接口上限 500，这里留余量并给群之间留节奏） */
const BATCH_SIZE = 100
/** 批量之间的间隔（毫秒）：Base 接口有 QPS 限制，串行 + 间隔最稳） */
const BATCH_GAP_MS = 120

/** Base 字段类型码 */
const T_TEXT = 1
const T_NUMBER = 2
const T_SINGLE = 3
const T_DATE = 5
const T_ATTACH = 17

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

/** 「议题证据」子表:一行一条证据消息(append-only,天然幂等) */
const EVIDENCE_FIELDS: FieldSpec[] = [
  { name: '证据ID', type: T_TEXT },
  { name: '议题ID', type: T_TEXT },
  { name: '议题标题', type: T_TEXT },
  { name: '客户群', type: T_TEXT },
  { name: '序号', type: T_NUMBER },
  { name: '时间', type: T_DATE },
  { name: '发送人', type: T_TEXT },
  { name: '来源', type: T_SINGLE, options: ['客户', '我方同事', '我方'] },
  { name: '内容', type: T_TEXT },
  {
    name: '类型',
    type: T_SINGLE,
    options: ['文本', '图片', '语音', '视频', '表情', '链接/卡片', '名片', '位置']
  },
  // 图片证据的真图(默认不上传:客户发的原图比文字更敏感,单独一个开关管)
  { name: '证据图', type: T_ATTACH }
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

/** 当前列名映射（空对象 = 全部用标准列名） */
export function getFieldMap(): FieldMap {
  const raw = (getConfig(CFG_FIELD_MAP) ?? '').trim()
  if (!raw) return {}
  try {
    const v = JSON.parse(raw) as unknown
    if (!v || typeof v !== 'object') return {}
    const out: FieldMap = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const name = typeof val === 'string' ? val.trim() : ''
      if (k.trim() && name) out[k.trim()] = name
    }
    return out
  } catch {
    return {}
  }
}

export function setFieldMap(map: FieldMap): void {
  const clean: FieldMap = {}
  for (const [k, v] of Object.entries(map ?? {})) {
    if (k.trim() && typeof v === 'string' && v.trim()) clean[k.trim()] = v.trim()
  }
  setConfig(CFG_FIELD_MAP, Object.keys(clean).length > 0 ? JSON.stringify(clean) : '')
}

export function getPrimaryField(): string {
  return (getConfig(CFG_PRIMARY_FIELD) ?? '').trim()
}

/** 类型不符的列名(同步时跳过;设置页会提示用户去改列类型或做列名映射) */
export function getConflictedFields(): string[] {
  const raw = (getConfig(CFG_CONFLICTS) ?? '').trim()
  if (!raw) return []
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** 是否具备三列回写条件（缺列则同步退化为纯单向） */
export function canWriteBack(fieldNames: string[]): boolean {
  const map = getFieldMap()
  return COLLAB_KEYS.every((k) => fieldNames.includes(mapFieldName(k, map)))
}

/** 同步结果入历史环（最近 20 条，供设置页/监控页展示） */
function pushHistory(
  kind: 'issue' | 'pull' | 'reply' | 'evidence',
  r: SyncOutResult | PullResult
): void {
  try {
    const raw = (getConfig(CFG_HISTORY) ?? '').trim()
    const list = raw ? (JSON.parse(raw) as unknown[]) : []
    const arr = Array.isArray(list) ? list : []
    arr.unshift({ ...r, kind })
    setConfig(CFG_HISTORY, JSON.stringify(arr.slice(0, 20)))
  } catch {
    /* 历史记录失败不影响同步 */
  }
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

/** 目标表字段元信息（名字 + 类型 + 是否主字段） */
async function listFields(
  appToken: string,
  tableId: string
): Promise<Array<{ name: string; type: number; primary: boolean }>> {
  const r = await larkCall<{
    items?: Array<{ field_name?: string; type?: number; is_primary?: boolean }>
  }>((api) =>
    api.bitable.appTableField.list({
      path: { app_token: appToken, table_id: tableId },
      params: { page_size: 100 }
    })
  )
  if (!r.ok) throw new Error(r.error)
  return (r.data.items ?? []).map((f, idx) => ({
    name: (f.field_name ?? '').trim(),
    type: Number(f.type ?? 0),
    // 飞书未回 is_primary 时按「第一列即主字段」的约定判定
    primary: f.is_primary === true || idx === 0
  }))
}

/**
 * 字段补齐：缺则建（带选项）。**只增不改不删** —— 目标表可能是用户自己的表。
 * 同名但类型不符的列不动，只在返回值里报出来（写入时飞书会报错，避免静默失败）。
 */
async function ensureFields(
  appToken: string,
  tableId: string,
  fields: FieldSpec[]
): Promise<{ added: string[]; conflicts: Array<{ name: string; want: number; got: number }> }> {
  const existing = await listFields(appToken, tableId)
  const byName = new Map(existing.map((f) => [f.name, f]))
  const added: string[] = []
  const conflicts: Array<{ name: string; want: number; got: number }> = []
  for (const spec of fields) {
    const have = byName.get(spec.name)
    if (have) {
      if (have.type !== spec.type)
        conflicts.push({ name: spec.name, want: spec.type, got: have.type })
      continue
    }
    const r = await larkCall((api) =>
      api.bitable.appTableField.create({
        path: { app_token: appToken, table_id: tableId },
        data: fieldPayload(spec)
      })
    )
    if (!r.ok) {
      // 主字段不可改名/重名等：记录但不致命，后续写入会暴露具体缺哪个字段
      syncLog.warn(`补字段「${spec.name}」失败: ${r.error}`)
      continue
    }
    added.push(spec.name)
    await sleep(BATCH_GAP_MS)
  }
  return { added, conflicts }
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
  const { added } = await ensureFields(appToken, tableId, fields)
  return { tableId, created, fieldsAdded: added }
}

export interface BaseVerifyResult {
  ok: boolean
  error?: string
  /** 预览模式:只做自检,不改表结构、不落配置 */
  preview?: boolean
  appToken?: string
  /** Base 名称(展示用) */
  appName?: string
  issuesTableId?: string
  /** 议题表实际名字(可能是用户表「数据表」,也可能是自动建的「议题」) */
  issuesTableName?: string
  issuesTableCreated?: boolean
  repliesTableId?: string
  /** 目标议题表已有的列 */
  existingFields?: string[]
  /** 将新建的列 */
  missingFields?: string[]
  /** 同名但类型不符(不动它,只报出来) */
  typeConflicts?: Array<{ name: string; want: number; got: number }>
  /** 主字段名(同步时把标题写进这一列) */
  primaryField?: string
  /** 三列(状态/跟进人/处理备注)齐全 → 支持同事回写 */
  canWriteBack?: boolean
  notes: string[]
}

export interface VerifyOptions {
  /** 预览:只自检不落库(不建表、不建字段、不写测试、不写配置) */
  preview?: boolean
}

/**
 * 验证链接 + 建表建字段 + 写一条测试记录再删掉（把「读得到/write 得进」一次说清）。
 * 成功后把 app_token 与两张表 id 落配置，后续同步直接复用。
 */
/** 目标表名(链接指定时用于展示) */
async function tableNameOf(appToken: string, tableId: string): Promise<string> {
  const r = await larkCall<{ items?: Array<{ table_id?: string; name?: string }> }>((api) =>
    api.bitable.appTable.list({ path: { app_token: appToken }, params: { page_size: 100 } })
  )
  if (!r.ok) return ''
  return (r.data.items ?? []).find((t) => t.table_id === tableId)?.name ?? ''
}

/**
 * 验证链接 + (可选)建表建字段 + 写一条测试记录再删掉。
 *
 * `preview=true` 只做自检:读 Base 名 / 目标表名 / 现有列 / 将新建列 / 类型冲突 / 主字段 / 回写能力,
 * **不建表、不建字段、不写测试、不写配置** —— 设置页据此先给用户看"将发生什么"。
 *
 * 目标议题表的选择:`链接里带 table=…` → **就用那张表**(用户自己的表,只补列不新建);
 * 不带 → 沿用旧行为(按名字找/建「议题」表)。
 */
export async function verifyBaseLink(
  link: string,
  opts: VerifyOptions = {}
): Promise<BaseVerifyResult> {
  const notes: string[] = []
  const parsed = parseBaseRef(link)
  if (!parsed.ok) return { ok: false, error: parsed.error, notes }
  const appToken = parsed.ref.appToken
  const linkTableId = parsed.ref.tableId

  try {
    // Base 名(仅展示;失败不致命)
    let appName = ''
    const meta = await larkCall<{ app?: { name?: string } }>((api) =>
      api.request({ method: 'GET', url: `open-apis/bitable/v1/apps/${appToken}` })
    )
    if (meta.ok) appName = meta.data.app?.name ?? ''

    // ── 议题表:链接指定就用它 ──
    let issuesTableId = ''
    let issuesTableName = ''
    let created = false
    if (linkTableId) {
      issuesTableId = linkTableId
      issuesTableName = (await tableNameOf(appToken, linkTableId)) || linkTableId
      notes.push(`使用链接指定的数据表「${issuesTableName}」(不新建)`)
    } else {
      const found = await findTable(appToken, ISSUE_TABLE_NAME)
      if (found) {
        issuesTableId = found
        issuesTableName = ISSUE_TABLE_NAME
        notes.push(`复用已有数据表「${ISSUE_TABLE_NAME}」`)
      } else if (opts.preview) {
        issuesTableName = ISSUE_TABLE_NAME
        notes.push(`将新建数据表「${ISSUE_TABLE_NAME}」`)
      } else {
        const t = await ensureTable(appToken, ISSUE_TABLE_NAME, ISSUE_FIELDS)
        issuesTableId = t.tableId
        issuesTableName = ISSUE_TABLE_NAME
        created = t.created
        notes.push(
          t.created ? `已创建数据表「${ISSUE_TABLE_NAME}」` : `复用数据表「${ISSUE_TABLE_NAME}」`
        )
        if (t.fieldsAdded.length > 0) notes.push(`议题表补字段: ${t.fieldsAdded.join('、')}`)
      }
    }

    // ── 字段自检(预览与执行共用) ──
    let existingFields: string[] | undefined
    let missingFields: string[] | undefined
    let typeConflicts: BaseVerifyResult['typeConflicts']
    let primaryField = ''
    if (!issuesTableId) {
      // 预览且将新建表:所有标准列都会新建(此前这一支漏报,预览会误显示"字段已齐")
      const map = getFieldMap()
      existingFields = []
      missingFields = ISSUE_FIELDS.map((s) => mapFieldName(s.name, map))
      typeConflicts = []
      notes.push(`将新建数据表并创建 ${missingFields.length} 列: ${missingFields.join('、')}`)
    } else {
      const have = await listFields(appToken, issuesTableId)
      existingFields = have.map((f) => f.name)
      // 主字段:只有文本类型才写标题(单选/数字/日期类型写入必然失败)
      const primary = have.find((f) => f.primary)
      if (primary && primary.type === T_TEXT) primaryField = primary.name
      else if (primary) {
        notes.push(
          `主字段「${primary.name}」不是文本类型(type=${primary.type}),不写入标题;标题仍写入标准「标题」列`
        )
      }
      const map = getFieldMap()
      const wanted = ISSUE_FIELDS.map((s) => mapFieldName(s.name, map))
      const haveSet = new Set(existingFields)
      missingFields = wanted.filter((n) => !haveSet.has(n))
      // 类型冲突:同名但类型不符(不动它,写入时飞书会报错,这里先讲清楚)
      typeConflicts = []
      for (const spec of ISSUE_FIELDS) {
        const name = mapFieldName(spec.name, map)
        const hit = have.find((f) => f.name === name)
        if (hit && hit.type !== spec.type) {
          typeConflicts.push({ name, want: spec.type, got: hit.type })
        }
      }
      notes.push(
        `目标表现有 ${existingFields.length} 列${missingFields.length > 0 ? `,将新建 ${missingFields.length} 列: ${missingFields.join('、')}` : ',字段已齐'}`
      )
      if (primaryField) notes.push(`主字段「${primaryField}」:同步时会把问题标题写进这一列`)
      if (typeConflicts.length > 0) {
        notes.push(
          `⚠ 类型不符(不改动,可能导致写入失败): ${typeConflicts.map((c) => `${c.name}(现有 ${c.got} / 需要 ${c.want})`).join('、')}`
        )
      }
    }

    // ── 回复表:始终由我们建/复用 ──
    let repliesTableId = ''
    if (opts.preview) {
      const found = await findTable(appToken, REPLY_TABLE_NAME)
      repliesTableId = found ?? ''
      notes.push(
        found ? `复用已有数据表「${REPLY_TABLE_NAME}」` : `将新建数据表「${REPLY_TABLE_NAME}」`
      )
    } else {
      await sleep(BATCH_GAP_MS)
      const replies = await ensureTable(appToken, REPLY_TABLE_NAME, REPLY_FIELDS)
      repliesTableId = replies.tableId
      notes.push(
        replies.created
          ? `已创建数据表「${REPLY_TABLE_NAME}」`
          : `复用已有数据表「${REPLY_TABLE_NAME}」`
      )
      if (replies.fieldsAdded.length > 0)
        notes.push(`回复表补字段: ${replies.fieldsAdded.join('、')}`)
    }

    // 注意:变量名不能与上面的 canWriteBack() 同名(否则初始化器里自我引用)
    const writeBackOk =
      (existingFields ?? []).length > 0 ? canWriteBack(existingFields ?? []) : false
    const base: BaseVerifyResult = {
      ok: true,
      preview: !!opts.preview,
      appToken,
      appName,
      issuesTableId: issuesTableId || undefined,
      issuesTableName,
      issuesTableCreated: created,
      repliesTableId: repliesTableId || undefined,
      existingFields,
      missingFields,
      typeConflicts,
      primaryField: primaryField || undefined,
      canWriteBack: writeBackOk,
      notes
    }

    if (opts.preview) {
      notes.push('以上为预览:尚未建表/建列,点「执行并建表」后才会真正写入')
      return base
    }

    if (!issuesTableId) throw new Error('未解析出议题表 id')

    // 写测试:真正证明「有写权限」,而不是只读得动(列名按映射)
    const map = getFieldMap()
    const idCol = mapFieldName('议题ID', map)
    const titleCol = mapFieldName('标题', map)
    const testFields: Record<string, unknown> = {
      [idCol]: '__verify__',
      [titleCol]: '同步连通性测试（会自动删除）'
    }
    const createdRec = await larkCall<{ record?: { record_id?: string } }>((api) =>
      api.bitable.appTableRecord.create({
        path: { app_token: appToken, table_id: issuesTableId },
        data: { fields: testFields }
      })
    )
    if (!createdRec.ok) {
      return {
        ...base,
        ok: false,
        error:
          '读得到但写不进：请在开放平台给应用开通多维表格**读写**权限（bitable:app）并发布版本 —— ' +
          createdRec.error
      }
    }
    const recordId = createdRec.data.record?.record_id
    notes.push('写入测试记录成功（读写权限 OK）')
    if (recordId) {
      const del = await larkCall((api) =>
        api.bitable.appTableRecord.delete({
          path: { app_token: appToken, table_id: issuesTableId, record_id: recordId }
        })
      )
      notes.push(
        del.ok ? '测试记录已删除' : `测试记录删除失败（请手动删掉「__verify__」那行）: ${del.error}`
      )
    }

    // 换了一个多维表格:旧映射指向的是另一个 Base 的记录,留着只会"更新失败/推到错表";
    // 证据子表 id 也必须重置(否则证据会推到旧 Base 的那张表里)。
    const oldToken = (getConfig(CFG_TOKEN) ?? '').trim()
    if (oldToken && oldToken !== appToken) {
      const nIssue = clearSyncRefs('issue')
      const nReply = clearSyncRefs('reply')
      const nEvidence = clearSyncRefs('evidence')
      setConfig(CFG_EV_TABLE, '')
      setConfig(CFG_EV_LINK, '')
      setConfig(CFG_LAST_AT, '0')
      setConfig(CFG_EV_LAST_AT, '0')
      // 素材 token 与附件写入状态都是 Base 级的:换了表就一律作废,重新上传
      clearMediaRefs()
      clearAttached()
      notes.push(
        `目标换成了另一个多维表格:已清掉旧映射(议题 ${nIssue} · 回复 ${nReply} · 证据 ${nEvidence} 条),下一次同步会全部重新写入新表`
      )
    }
    setConfig(CFG_TOKEN, appToken)
    // 人话名与原始链接:UI 上显示「Base「智能客服运营跟踪」· 表「数据表」」,
    // 链接只留在「高级信息」里(重新配置时能回填成完整 URL,而不是一串 token)
    setConfig(CFG_BASE_NAME, appName || '')
    setConfig(CFG_TABLE_ISSUES_NAME, issuesTableName || '')
    setConfig(CFG_BASE_LINK, link.trim())
    setConfig(CFG_CAN_WRITE_BACK, writeBackOk ? '1' : '0')
    setConfig(CFG_TABLE_ISSUES, issuesTableId)
    setConfig(CFG_TABLE_REPLIES, repliesTableId)
    setConfig(CFG_PRIMARY_FIELD, primaryField || '')
    // 类型不符的列记下来:同步时跳过这些列,避免"一条坏列毁掉整条记录"
    setConfig(
      CFG_CONFLICTS,
      (typeConflicts ?? []).length > 0
        ? JSON.stringify((typeConflicts ?? []).map((c) => c.name))
        : ''
    )
    return base
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
  /** 因列类型不符被跳过的列次数(>0 时设置页会提示去改列或做映射) */
  skippedFields?: number
  /** 证据附件(图片):本轮真正上传/写进附件列的条数 */
  mediaUploaded?: number
  /** 证据附件:复用已上传素材(没走网络)的条数 */
  mediaCached?: number
  /** 证据附件:被跳过的条数(非图片 / 超上限) */
  mediaSkipped?: number
  /** 证据附件:上传或写入失败的条数(下一轮会重试) */
  mediaFailed?: number
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
    issuesTableName: (getConfig(CFG_TABLE_ISSUES_NAME) ?? '').trim()
  }
}

/** 按当前开关与三重上限,算出"本轮还会推几条证据"(开关关闭时恒为 0) */
function countPendingEvidence(): number {
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

function readLastEvidence(): SyncOutResult | null {
  const raw = getConfig(CFG_EV_LAST)
  if (!raw) return null
  try {
    return JSON.parse(raw) as SyncOutResult
  } catch {
    return null
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

/** 清掉素材与附件缓存(baseClear / 换 Base 用):token 是 Base 级的,换表即失效 */
export function resetEvidenceMedia(): { media: number; attached: number } {
  return { media: clearMediaRefs(), attached: clearAttached() }
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
        status: String(b.fields[colOf('状态')] ?? ''),
        assignee: String(b.fields[colOf('跟进人')] ?? ''),
        pushed: true
      })
      out.created++
    })
    await sleep(BATCH_GAP_MS)
  }

  for (const issue of rows) {
    const fields = issueToFields(issue, names, { fieldMap, primaryField })
    if (conflicts.size > 0) {
      for (const k of Object.keys(fields)) if (conflicts.has(k)) delete fields[k]
      out.skippedFields = (out.skippedFields ?? 0) + 1
    }
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
      status: String(fields[colOf('状态')] ?? ''),
      assignee: String(fields[colOf('跟进人')] ?? ''),
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
  /** 本轮说明（如：目标表缺少回写列，已跳过回写） */
  note?: string
  at: number
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
 * 按「议题ID」列把 Base 行与本地议题对上并写入映射，避免同步时**重复插入**。
 * 不写入协作列的上次已知值 —— 让首轮拉取能把同事已填的状态/跟进人带进本地。
 */
export async function claimExistingRecords(
  appToken: string,
  tableId: string
): Promise<ClaimResult> {
  const out: ClaimResult = { ok: false, scanned: 0, claimed: 0, already: 0, unmatched: 0 }
  const map = getFieldMap()
  const idCol = mapFieldName('议题ID', map)
  const records = await listIssueRecords(appToken, tableId, [idCol])
  out.scanned = records.length
  for (const rec of records) {
    const idText = String(rec.fields[idCol] ?? '').trim()
    const localId = Number.parseInt(idText, 10)
    if (!Number.isFinite(localId) || !getIssueById(localId)) {
      out.unmatched++
      continue
    }
    const ref = getSyncRef('issue', localId)
    if (ref && ref.recordId === rec.recordId) {
      out.already++
      continue
    }
    // contentHash 留空 → 下一轮推送会补写程序列(把我们的列填上);协作列留给首轮拉取
    saveSyncRef('issue', localId, appToken, tableId, rec.recordId, '')
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
  // 回写闸门:目标表没有 状态/跟进人/处理备注 三列时,同步退化为单向(不再报错刷日志)
  try {
    const have = (await listFields(appToken, tableId)).map((f) => f.name)
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
      mapFieldName('状态', map),
      mapFieldName('跟进人', map),
      mapFieldName('处理备注', map)
    ])
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
    const idText = String(rec.fields[idCol] ?? '').trim()
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

// ── 议题证据明细 → Base 子表 ──

export interface EvidenceConfig {
  enabled: boolean
  days: number
  maxPerIssue: number
  maxChars: number
  tableId: string
  /** 是否把图片证据的真图传到「证据图」附件列(默认关:原图比文字更敏感) */
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
function pickPerIssue<T extends { issueId: number; seqNo: number }>(rows: T[], max: number): T[] {
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
    localType?: number
    imageMd5?: string
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
        if (!isEvidenceImage(src.localType, src.imageMd5)) return
        attachQueue.push({
          msgId: src.msgId,
          recordId,
          accountWxid: src.accountWxid,
          localType: src.localType,
          imageMd5: src.imageMd5
        })
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
      if (!isEvidenceImage(row.localType, row.imageMd5)) continue
      if (attachQueue.some((a) => a.msgId === row.msgId)) continue
      if (hasAttached(row.msgId)) continue
      const ref = getSyncRef('evidence', row.msgId)
      if (!ref || ref.tableId !== tableId) continue
      attachQueue.push({
        msgId: row.msgId,
        recordId: ref.recordId,
        accountWxid: row.accountWxid,
        localType: row.localType,
        imageMd5: row.imageMd5
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
async function attachEvidenceImages(opts: {
  appToken: string
  tableId: string
  queue: Array<{
    msgId: number
    recordId: string
    accountWxid: string
    localType?: number
    imageMd5?: string
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
    const up = await uploadEvidenceImage({
      appToken,
      accountWxid: item.accountWxid,
      localType: item.localType,
      imageMd5: item.imageMd5,
      maxMediaMB: cfg.maxMediaMB
    })
    if (!up.ok || !up.fileToken) {
      if (up.skipped) out.mediaSkipped = (out.mediaSkipped ?? 0) + 1
      else out.mediaFailed = (out.mediaFailed ?? 0) + 1
      continue
    }
    if (up.cached) out.mediaCached = (out.mediaCached ?? 0) + 1
    const md5 = imageMd5Of(item.imageMd5)
    if (!md5) continue
    batch.push({ recordId: item.recordId, msgId: item.msgId, md5, token: up.fileToken })
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
