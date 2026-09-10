import { getConfig, setConfig } from '../../db/repos/config'

/**
 * 群级参与开关：哪些群**不纳入**问题监控。
 *
 * 为什么需要：后台默认把「近 7 天活跃群」全当客服群分析，但实际清单里混着采购群、叫货群、
 * 供应链对接群 —— 里面的「发票请查收」「快递单号」「收到」会被提成客户问题，
 * 在看板上堆成永远无法「跟进」的假待办（实测三个采购群贡献了 12 条 open）。
 *
 * 语义：
 * - 只影响**自动路径**（后台增量提取 / 收尾巡检 / 全量重析）；
 * - 手动「重新分析」仍然可用（用户显式操作，不该被拦）；
 * - 配置按账号存：`issue.groups.exclude:<wxid>` = 群 username 的 JSON 数组。
 */
const key = (wxid: string): string => `issue.groups.exclude:${wxid}`

/** 已排除的群 username 集合（解析失败按空处理，不阻断分析） */
export function listExcludedGroups(wxid: string): Set<string> {
  const raw = getConfig(key(wxid))
  if (!raw) return new Set()
  try {
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return new Set()
    return new Set(arr.filter((x): x is string => typeof x === 'string' && x.trim() !== ''))
  } catch {
    return new Set()
  }
}

export function isGroupExcluded(wxid: string, groupUsername: string): boolean {
  if (!groupUsername) return false
  return listExcludedGroups(wxid).has(groupUsername)
}

/** 写入排除集合（excluded=false 即恢复监控）；返回更新后的集合 */
export function setGroupExcluded(
  wxid: string,
  groupUsername: string,
  excluded: boolean
): Set<string> {
  const set = listExcludedGroups(wxid)
  if (excluded) set.add(groupUsername)
  else set.delete(groupUsername)
  setConfig(key(wxid), JSON.stringify(Array.from(set)))
  return set
}

/** 是否需要跳过该群的**自动**分析 */
export function skipAutoAnalysis(wxid: string, groupUsername: string): boolean {
  return isGroupExcluded(wxid, groupUsername)
}
