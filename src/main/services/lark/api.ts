import { getConfig } from '../../db/repos/config'
import { clipOneLine } from '../../util/text'
import { larkCall, type LarkCallResult } from './client'
import { larkKindText, parseLarkRef, type LarkRef } from './url'
import { fetchFields } from './fields'

/**
 * 飞书云文档只读数据面(多维表格 / 云文档 / 知识库节点解析)。
 * - 全部只读, 无写接口;工具层与设置页测试共用本文件(唯一实现);
 * - 输出为模型可读的 Markdown 文本, 并做列/单元格/行数裁剪, 避免撑爆上下文预算;
 * - 错误一律转成可行动的中文提示(凭证缺失/权限不足/token 不存在)。
 */

export interface LarkTable {
  tableId: string
  name: string
}

export interface LarkField {
  fieldId: string
  name: string
  type: number
}

export interface LarkRecord {
  recordId: string
  fields: Record<string, unknown>
}

/** 统一结果类型与调用包装(实现见 client.ts,全模块共用一份) */
type LarkResult<T> = LarkCallResult<T>
const call = larkCall

const MAX_TABLES = 200
const MAX_ROWS = 200
const MAX_COLS = 12
const CELL_CHARS = 80

/* ══════════ 多维表格(Base) ══════════ */

export async function listTables(
  appToken: string
): Promise<LarkResult<{ tables: LarkTable[]; hasMore: boolean; pageToken?: string }>> {
  const out: LarkTable[] = []
  let pageToken: string | undefined
  let hasMore = false
  for (let page = 0; page < 4; page += 1) {
    const r = await call<{
      items?: Array<{ table_id?: string; name?: string }>
      has_more?: boolean
      page_token?: string
    }>((api) =>
      api.bitable.appTable.list({
        path: { app_token: appToken },
        params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) }
      })
    )
    if (!r.ok) return r
    for (const it of r.data.items ?? []) {
      if (it.table_id) out.push({ tableId: it.table_id, name: it.name || '(未命名数据表)' })
    }
    hasMore = !!r.data.has_more
    pageToken = r.data.page_token
    if (!hasMore || !pageToken || out.length >= MAX_TABLES) break
  }
  return { ok: true, data: { tables: out, hasMore, pageToken } }
}

export async function listFields(
  appToken: string,
  tableId: string
): Promise<LarkResult<{ fields: LarkField[] }>> {
  // 实现收敛到 ./fields(带 30s 缓存),这里只做类型与结果包装
  try {
    const rows = await fetchFields(appToken, tableId)
    return {
      ok: true,
      data: { fields: rows.map((f) => ({ fieldId: f.fieldId, name: f.name, type: f.type })) }
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function listRecords(input: {
  appToken: string
  tableId: string
  viewId?: string
  pageSize?: number
  pageToken?: string
}): Promise<
  LarkResult<{ records: LarkRecord[]; hasMore: boolean; pageToken?: string; total?: number }>
> {
  const pageSize = Math.min(Math.max(input.pageSize ?? 50, 1), 200)
  const r = await call<{
    items?: Array<{ record_id?: string; fields?: Record<string, unknown> }>
    has_more?: boolean
    page_token?: string
    total?: number
  }>((api) =>
    api.bitable.appTableRecord.list({
      path: { app_token: input.appToken, table_id: input.tableId },
      params: {
        page_size: pageSize,
        ...(input.viewId ? { view_id: input.viewId } : {}),
        ...(input.pageToken ? { page_token: input.pageToken } : {})
      }
    })
  )
  if (!r.ok) return r
  const records: LarkRecord[] = (r.data.items ?? []).map((it) => ({
    recordId: it.record_id ?? '',
    fields: it.fields ?? {}
  }))
  return {
    ok: true,
    data: {
      records,
      hasMore: !!r.data.has_more,
      pageToken: r.data.page_token,
      total: r.data.total
    }
  }
}

/* ══════════ 云文档(docx) / 知识库(wiki) ══════════ */

export async function docxText(docId: string): Promise<LarkResult<{ text: string }>> {
  const r = await call<{ content?: string }>((api) =>
    api.docx.document.rawContent({ path: { document_id: docId } })
  )
  if (!r.ok) return r
  return { ok: true, data: { text: r.data.content ?? '' } }
}

export async function resolveWikiNode(
  token: string
): Promise<LarkResult<{ objToken: string; objType: string; title: string }>> {
  const r = await call<{
    node?: { obj_token?: string; obj_type?: string; title?: string }
  }>((api) => api.wiki.space.getNode({ params: { token } }))
  if (!r.ok) return r
  const node = r.data.node
  if (!node?.obj_token) return { ok: false, error: '知识库节点解析失败(未返回文档 token)' }
  return {
    ok: true,
    data: { objToken: node.obj_token, objType: node.obj_type ?? '', title: node.title ?? '' }
  }
}

/* ══════════ 值渲染 ══════════ */

/** 单元格值 → 文本(多维表格字段类型很多, 这里做通用降级) */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) {
    return v
      .map((x) => cellText(x))
      .filter(Boolean)
      .join('、')
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (typeof o.text === 'string' && o.text) return o.text
    if (typeof o.name === 'string' && o.name) return o.name
    if (typeof o.link === 'string' && o.link) return o.link
    if (typeof o.full_address === 'string' && o.full_address) return o.full_address
    if (typeof o.address === 'string' && o.address) return o.address
    try {
      return JSON.stringify(o)
    } catch {
      return String(o)
    }
  }
  return String(v)
}

/** 记录 → Markdown 表格(列/单元格裁剪; 表头用字段名) */
export function renderRecords(records: LarkRecord[], fields: LarkField[]): string {
  if (records.length === 0) return '(该数据表在当前视图下没有记录)'
  const names = fields.length > 0 ? fields.map((f) => f.name) : Object.keys(records[0].fields)
  const cols = names.slice(0, MAX_COLS)
  const head = `| ${cols.map((c) => clipOneLine(c, 24)).join(' | ')} |`
  const sep = `| ${cols.map(() => '---').join(' | ')} |`
  const rows = records.map((r) => {
    const cells = cols.map((c) => clipOneLine(cellText(r.fields[c]), CELL_CHARS) || ' ')
    return `| ${cells.join(' | ')} |`
  })
  const extra =
    names.length > cols.length ? `\n(共 ${names.length} 列, 已只展示前 ${cols.length} 列)` : ''
  return [head, sep, ...rows].join('\n') + extra
}

/* ══════════ 面向工具/设置页的高层读取(唯一实现) ══════════ */

export interface ReadBaseInput {
  /** 飞书链接或 app_token(二选一) */
  url?: string
  appToken?: string
  tableId?: string
  viewId?: string
  /** 读取记录条数上限(默认 50, 最大 200) */
  limit?: number
  /** 分页游标(上一页返回的 pageToken) */
  pageToken?: string
}

/** 读取结果(带 ok, 便于设置页区分成败;工具层只用 text) */
export interface LarkReadResult {
  ok: boolean
  text: string
}

/** 读多维表格: 未指定 table_id → 返回数据表清单;指定 → 返回记录表 */
export async function readBaseResult(input: ReadBaseInput): Promise<LarkReadResult> {
  const raw = (input.url ?? '').trim() || (getConfig('lark.defaultUrl') ?? '').trim()
  let ref: LarkRef | null = input.appToken
    ? { kind: 'base', token: input.appToken.trim(), raw: input.appToken.trim() }
    : parseLarkRef(raw)
  if (!ref) {
    return {
      ok: false,
      text: '未识别到飞书文档链接: 请粘贴形如 https://xxx.feishu.cn/base/<app_token>?table=<table_id> 的链接。'
    }
  }
  const tableId = (input.tableId ?? ref.tableId ?? '').trim()
  const viewId = (input.viewId ?? ref.viewId ?? '').trim()
  let appToken = ref.token

  // 知识库链接 → 解析真实文档 token/类型
  if (ref.kind === 'wiki') {
    const node = await resolveWikiNode(ref.token)
    if (!node.ok) return { ok: false, text: node.error }
    const { objToken, objType, title } = node.data
    if (objType === 'bitable') {
      appToken = objToken
      ref = { kind: 'base', token: objToken, raw: ref.raw }
    } else if (objType === 'docx' || objType === 'doc') {
      return { ok: true, text: await readDocAsText(objToken) }
    } else {
      return {
        ok: false,
        text: `知识库节点「${title || ref.token}」是 ${objType || '未知'} 类型, 当前只支持读取多维表格与云文档(docx)。`
      }
    }
  }
  if (ref.kind === 'docx') return { ok: true, text: await readDocAsText(ref.token) }
  if (ref.kind === 'sheets') {
    return {
      ok: false,
      text: '暂不支持直接读取飞书电子表格(sheet): 请在飞书里「导出 → CSV/Excel」后放入工作区, 再用表格工具读取;或改用多维表格链接。'
    }
  }

  if (!tableId) {
    const t = await listTables(appToken)
    if (!t.ok) return { ok: false, text: t.error }
    if (t.data.tables.length === 0) {
      return { ok: false, text: '该多维表格下没有可见的数据表(或应用无权限)。' }
    }
    const lines = t.data.tables.map((x, i) => `${i + 1}. ${x.name} (table_id=${x.tableId})`)
    return {
      ok: true,
      text: [
        `该多维表格共 ${t.data.tables.length} 个数据表:`,
        ...lines,
        '',
        '读取某张表的数据时, 再调用一次并带上 table_id。'
      ].join('\n')
    }
  }

  const limit = Math.min(Math.max(input.limit ?? 50, 1), MAX_ROWS)
  const fields = await listFields(appToken, tableId)
  const rec = await listRecords({
    appToken,
    tableId,
    viewId: viewId || undefined,
    pageSize: limit,
    pageToken: input.pageToken
  })
  if (!rec.ok) return { ok: false, text: rec.error }
  const fieldNames = fields.ok ? fields.data.fields : []
  const totalText =
    typeof rec.data.total === 'number' ? `共 ${rec.data.total} 条记录` : '记录数未知'
  const shown = rec.data.records.length
  const parts = [
    `数据表 ${tableId}${viewId ? `(视图 ${viewId})` : ''}: ${totalText}, 本次返回 ${shown} 条。`,
    '',
    renderRecords(rec.data.records, fieldNames)
  ]
  if (rec.data.hasMore && rec.data.pageToken) {
    parts.push('', `(还有更多记录: 继续读取请带上 page_token=${rec.data.pageToken})`)
  }
  return { ok: true, text: parts.join('\n') }
}

/** 工具层入口: 只要文本 */
export async function readBaseAsText(input: ReadBaseInput): Promise<string> {
  return (await readBaseResult(input)).text
}

/** 读云文档纯文本(链接或 document_id) */
export async function readDocAsText(urlOrToken: string): Promise<string> {
  const ref = parseLarkRef(urlOrToken)
  let docId = (urlOrToken ?? '').trim()
  if (ref?.kind === 'docx') docId = ref.token
  else if (ref?.kind === 'wiki') {
    const node = await resolveWikiNode(ref.token)
    if (!node.ok) return node.error
    docId = node.data.objToken
  } else if (ref?.kind === 'base' || ref?.kind === 'sheets') {
    return `这是${larkKindText(ref.kind)}链接, 不是云文档(docx)。`
  }
  if (!docId) return '请提供飞书云文档链接或 document_id。'
  const r = await docxText(docId)
  if (!r.ok) return r.error
  const text = r.data.text.trim()
  if (!text) return '文档内容为空(或应用无阅读权限)。'
  return text.length > 12_000 ? `${text.slice(0, 12_000)}\n…(文档过长已截断)` : text
}

/** 设置页「测试连接」: 读取链接指向的多维表格/文档并返回摘要 */
export async function testLarkAccess(urlOrToken: string): Promise<LarkReadResult> {
  const ref = parseLarkRef(urlOrToken)
  if (!ref) return { ok: false, text: '未识别到飞书链接: 请粘贴 /base/、/docx/、/wiki/ 链接。' }
  if (ref.kind === 'base' || ref.kind === 'wiki') {
    const r = await readBaseResult({ url: urlOrToken, limit: 3 })
    return r.ok ? { ok: true, text: r.text.length > 800 ? `${r.text.slice(0, 800)}…` : r.text } : r
  }
  const text = await readDocAsText(urlOrToken)
  return { ok: true, text: text.length > 400 ? `${text.slice(0, 400)}…` : text }
}
