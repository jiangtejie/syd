/**
 * 飞书云文档链接解析(纯函数, 无 IO)。
 * 支持 /base/、/bitable/、/docx/、/wiki/、/sheets/ 链接, 以及裸 token(按多维表格处理)。
 * 说明: 链接里的租户域名(ex3uvbxvqj9.feishu.cn)不参与解析 —— 应用身份只能访问本租户资源,
 * 跨租户链接会在接口层返回权限错误。
 */

export type LarkRefKind = 'base' | 'docx' | 'wiki' | 'sheets'

export interface LarkRef {
  kind: LarkRefKind
  /** base=app_token; docx=document_id; wiki=node_token; sheets=spreadsheet_token */
  token: string
  /** /base/ 链接里的 table=tblxxx */
  tableId?: string
  /** /base/ 链接里的 view=vewxxx */
  viewId?: string
  raw: string
}

const ROUTES: Array<{ kind: LarkRefKind; re: RegExp }> = [
  { kind: 'base', re: /\/(?:base|bitable)\/([A-Za-z0-9]{8,})/ },
  { kind: 'docx', re: /\/docx\/([A-Za-z0-9]{8,})/ },
  { kind: 'wiki', re: /\/wiki\/([A-Za-z0-9]{8,})/ },
  { kind: 'sheets', re: /\/sheets\/([A-Za-z0-9]{8,})/ }
]

/** 裸 token(base app_token 形如 ZmQpbpYEhaDh5fsyPGjcPvUKnsb) */
const BARE_TOKEN_RE = /^[A-Za-z0-9_-]{16,}$/

function queryOf(raw: string): URLSearchParams {
  try {
    return new URL(raw).searchParams
  } catch {
    const i = raw.indexOf('?')
    return new URLSearchParams(i >= 0 ? raw.slice(i + 1).split('#')[0] : '')
  }
}

/** 解析用户给的链接/token;无法识别返回 null */
export function parseLarkRef(input: string): LarkRef | null {
  const raw = (input ?? '').trim()
  if (!raw) return null
  for (const r of ROUTES) {
    const m = r.re.exec(raw)
    if (!m) continue
    const ref: LarkRef = { kind: r.kind, token: m[1], raw }
    // base 链接直接带 table/view;wiki 里嵌的多维表格同样会带 ?table=&view=(解析后再取)
    if (r.kind === 'base' || r.kind === 'wiki') {
      const q = queryOf(raw)
      ref.tableId = (q.get('table') ?? q.get('table_id') ?? '').trim() || undefined
      ref.viewId = (q.get('view') ?? q.get('view_id') ?? '').trim() || undefined
    }
    return ref
  }
  if (BARE_TOKEN_RE.test(raw)) return { kind: 'base', token: raw, raw }
  return null
}

/** 链接类型的中文名(报错提示用) */
export function larkKindText(kind: LarkRefKind): string {
  return kind === 'base'
    ? '多维表格(Base)'
    : kind === 'docx'
      ? '云文档(docx)'
      : kind === 'wiki'
        ? '知识库(wiki)'
        : '电子表格(sheet)'
}
