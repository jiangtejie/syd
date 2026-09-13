/**
 * 飞书列元信息的分页聚合（**纯函数，零依赖**）。
 *
 * 为什么单独一个文件：字段查询逻辑要能被离线自检覆盖（`scripts/lark-sync-selftest.mjs` 用假 transport 跑），
 * 而 `fields.ts` 会连带引入 client/SDK/DB 链路，在纯 Node 里跑不起来。这里只留纯逻辑，`fields.ts` 负责接线与缓存。
 */

export interface RawFieldItem {
  field_id?: string
  field_name?: string
  type?: number
  is_primary?: boolean
}

export interface FieldPage {
  items?: RawFieldItem[]
  has_more?: boolean
  page_token?: string
}

export interface LarkFieldMeta {
  fieldId: string
  name: string
  type: number
  primary: boolean
}

/**
 * 单条原始列 → 统一元信息。
 * primary：飞书没回 is_primary 时按「第一列即主字段」的约定判定，所以只有**第一页的第一条**才给这个兜底。
 */
export function toFieldMeta(
  item: RawFieldItem,
  opts: { firstOfFirstPage?: boolean } = {}
): LarkFieldMeta {
  return {
    fieldId: item.field_id ?? '',
    name: (item.field_name ?? '').trim(),
    type: Number(item.type ?? 0),
    primary: item.is_primary === true || opts.firstOfFirstPage === true
  }
}

/**
 * 按页拉取并聚合列元信息。
 * 终止条件：has_more=false / 没有 page_token / 达到 maxPages（默认 4，即最多 400 列，够用且防跑飞）。
 */
export async function collectFieldPages(
  fetchPage: (pageToken?: string) => Promise<FieldPage>,
  maxPages = 4
): Promise<LarkFieldMeta[]> {
  const out: LarkFieldMeta[] = []
  let pageToken: string | undefined
  for (let page = 0; page < maxPages; page += 1) {
    const res = await fetchPage(pageToken)
    const items = res.items ?? []
    items.forEach((it, idx) => {
      if (!it.field_name) return
      out.push(toFieldMeta(it, { firstOfFirstPage: page === 0 && idx === 0 }))
    })
    pageToken = res.page_token
    if (!res.has_more || !pageToken) break
  }
  return out
}
