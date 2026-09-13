import { larkCall } from './client'
import { collectFieldPages, type LarkFieldMeta } from './fieldPages'

/**
 * 数据表列元信息（名字 / 类型 / 是否主字段 / field_id）。
 *
 * 为什么集中：审计发现 `listFields` 在 `api.ts`、`baseCore.ts`、`baseSystem.ts` 各写了一份，
 * 分页与字段名口径不一致（有的只要名字，有的要 field_id，有的按 200/页、有的按 100/页）。
 * 现在只有这一份实现，并带 30s 缓存 —— 一轮同步里同一张表常被查 2~3 次。
 * 分页聚合的纯逻辑在 `fieldPages.ts`（可离线自检），这里只负责接线与缓存。
 * 注意：**建列之后要调 invalidateFields**，否则 30s 内会读到旧结构。
 */
export type { LarkFieldMeta }

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

  const fields = await collectFieldPages(async (pageToken) => {
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
    return r.data
  })
  cache.set(key, { at: Date.now(), fields })
  return fields
}

/** 刚建完列/表时调用：让下一次 fetchFields 真的去问飞书 */
export function invalidateFields(appToken: string, tableId: string): void {
  cache.delete(appToken + '/' + tableId)
}
