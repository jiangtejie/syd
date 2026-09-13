import { larkCall } from './client'

/**
 * 数据表列元信息（名字 / 类型 / 是否主字段 / field_id）。
 *
 * 为什么集中：审计发现 `listFields` 在 `api.ts`、`baseCore.ts`、`baseSystem.ts` 各写了一份，
 * 分页与字段名口径不一致（有的只要名字，有的要 field_id，有的按 200/页、有的按 100/页）。
 * 现在只有这一份实现，并带 30s 缓存 —— 一轮同步里同一张表常被查 2~3 次。
 * 注意：**建列之后要调 invalidateFields**，否则 30s 内会读到旧结构。
 */
export interface LarkFieldMeta {
  fieldId: string
  name: string
  type: number
  primary: boolean
}

const TTL_MS = 30_000
const cache = new Map<string, { at: number; fields: LarkFieldMeta[] }>()

export async function fetchFields(
  appToken: string,
  tableId: string,
  opts: { fresh?: boolean } = {}
): Promise<LarkFieldMeta[]> {
  const key = appToken + '/' + tableId
  const hit = cache.get(key)
  if (!opts.fresh && hit && Date.now() - hit.at < TTL_MS) return hit.fields

  const out: LarkFieldMeta[] = []
  let pageToken: string | undefined
  for (let page = 0; page < 4; page += 1) {
    const r = await larkCall<{
      items?: Array<{ field_id?: string; field_name?: string; type?: number; is_primary?: boolean }>
      has_more?: boolean
      page_token?: string
    }>((api) =>
      api.bitable.appTableField.list({
        path: { app_token: appToken, table_id: tableId },
        params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) }
      })
    )
    if (!r.ok) throw new Error(r.error)
    const items = r.data.items ?? []
    items.forEach((f, idx) => {
      out.push({
        fieldId: f.field_id ?? '',
        name: (f.field_name ?? '').trim(),
        type: Number(f.type ?? 0),
        // 飞书未回 is_primary 时按「第一列即主字段」的约定判定
        primary: f.is_primary === true || (page === 0 && idx === 0)
      })
    })
    pageToken = r.data.page_token
    if (!r.data.has_more || !pageToken) break
  }
  cache.set(key, { at: Date.now(), fields: out })
  return out
}

/** 刚建完列/表时调用：让下一次 fetchFields 真的去问飞书 */
export function invalidateFields(appToken: string, tableId: string): void {
  cache.delete(appToken + '/' + tableId)
}
