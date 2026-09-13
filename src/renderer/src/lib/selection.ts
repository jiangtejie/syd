/**
 * 列表/详情联动的选中规则（纯函数，可自检）。
 *
 * 为什么抽出来:这类「选中项没了该选谁」的逻辑以前散在 useEffect 里,条件一多就出 bug ——
 * 问题监控就踩过:处置完一条(它从待处理列表里消失)后 active 仍指向它,右侧详情一直挂着那条已处置的问题,
 * 也不自动切到下一条。抽成纯函数后,规则能用断言钉住,组件里只剩一次调用。
 */

export interface SelectionAction<T> {
  kind: 'keep' | 'clear' | 'select'
  item?: T
}

export interface SelectionInput<T extends { id: number }> {
  /** 当前选中项(可能是列表刷新前的旧快照) */
  active: T | null
  /** 当前**可见**列表(已按页签/筛选/搜索过滤,顺序即展示顺序) */
  list: T[]
  /** 数据加载中:不做判断,避免拿半截数据把选中项清掉 */
  loading: boolean
  /** 用户自己加了筛选(搜索/类型/群/跟进人/严重度) */
  userFiltered: boolean
}

/**
 * 决定下一步怎么选:
 * 1. 选中项仍在可见列表里 → 不动(不打断正在处理的人);
 * 2. 选中项已离开视野(被处置/归档/合并/被筛掉) → 切到列表第一条(最前面那条),列表空则清空详情;
 * 3. 原本没选中:用户自己加了筛选就不主动选(避免乱跳),否则默认选第一条。
 */
export function nextSelection<T extends { id: number }>(
  input: SelectionInput<T>
): SelectionAction<T> {
  const { active, list, loading, userFiltered } = input
  if (loading) return { kind: 'keep' }
  const first = list[0]
  if (active && list.some((i) => i.id === active.id)) return { kind: 'keep' }
  if (!active && userFiltered) return { kind: 'keep' }
  if (!first) return active ? { kind: 'clear' } : { kind: 'keep' }
  if (active && active.id === first.id) return { kind: 'keep' }
  return { kind: 'select', item: first }
}
