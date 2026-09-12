import { getConfig, setConfig } from '../../db/repos/config'
import { getContactScope } from './contact'
// 纯函数放 baseMapping(可离线自检),这里转出保持引用路径
import { parseManualMap, personFieldValue } from './baseMapping'
export { parseManualMap, personFieldValue }
import { createLogger } from '../logging'

const personLog = createLogger('lark')

/**
 * 团队成员(本地称呼) → 飞书 open_id 的映射。
 *
 * 为什么要它:Base 的「人员」字段写的是 open_id(渲染成飞书成员,能 @提醒、能被自动化识别),
 * 而本地只知道同事的微信称呼。这里用应用可见的通讯录把两者对上,结果缓存到配置里并带 TTL,
 * **映射不上就留空**(绝不猜):宁可人员列为空,也不能把 A 的问题派给 B。
 *
 * 注意:能否读到人取决于开放平台的「数据权限 → 通讯录可见范围」;范围为空时这里会返回可行动的提示。
 */

const CFG_ENABLED = 'lark.person.enabled'
const CFG_FIELD = 'lark.person.field'
const CFG_MAP = 'lark.person.map'
/** 手工映射(每行「称呼=open_id」):通讯录读不到姓名时的兜底,优先级高于自动解析 */
const CFG_MANUAL = 'lark.person.manual'
const CFG_MAP_AT = 'lark.person.mapAt'
/** 映射结果的保鲜期:通讯录变动不频繁,一天刷一次够了 */
const MAP_TTL_MS = 24 * 3600_000

export interface PersonConfig {
  enabled: boolean
  /** Base 里人员列的列名(默认「处理人」) */
  field: string
  /** 已解析出的映射条数(含手工映射) */
  mapped: number
  /** 上次自动解析时间 */
  mappedAt: number
  /** 手工映射文本(每行「称呼=open_id」) */
  manual: string
}

export function getPersonConfig(): PersonConfig {
  const map = getPersonMap()
  return {
    enabled: (getConfig(CFG_ENABLED) ?? '') === '1',
    field: (getConfig(CFG_FIELD) ?? '').trim() || '处理人',
    mapped: Object.keys(map).length,
    mappedAt: Number(getConfig(CFG_MAP_AT) ?? 0) || 0,
    manual: getConfig(CFG_MANUAL) ?? ''
  }
}

export function setPersonConfig(patch: {
  enabled?: boolean
  field?: string
  manual?: string
}): PersonConfig {
  if (typeof patch.enabled === 'boolean') setConfig(CFG_ENABLED, patch.enabled ? '1' : '0')
  if (typeof patch.field === 'string') setConfig(CFG_FIELD, patch.field.trim().slice(0, 40))
  if (typeof patch.manual === 'string') setConfig(CFG_MANUAL, patch.manual.slice(0, 4000))
  return getPersonConfig()
}

/** 称呼 → open_id(空对象 = 还没解析过/解析不到) */
export function getPersonMap(): Record<string, string> {
  const manual = parseManualMap(getConfig(CFG_MANUAL) ?? '')
  const raw = (getConfig(CFG_MAP) ?? '').trim()
  if (!raw) return manual
  try {
    const v = JSON.parse(raw) as unknown
    if (!v || typeof v !== 'object') return {}
    const out: Record<string, string> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const name = k.trim()
      const id = typeof val === 'string' ? val.trim() : ''
      if (name && id) out[name] = id
    }
    // 手工映射优先:用户明确写的,比自动解析更可信
    return { ...out, ...manual }
  } catch {
    return manual
  }
}

/** 该称呼对应的 open_id;未映射返回 '' */
export function openIdOf(name: string | null | undefined): string {
  const key = (name ?? '').trim()
  if (!key) return ''
  return getPersonMap()[key] ?? ''
}

/** 映射是否过期(没有映射也算过期,便于首次自动解析) */
export function personMapStale(): boolean {
  const at = Number(getConfig(CFG_MAP_AT) ?? 0) || 0
  if (!at) return true
  return Date.now() - at > MAP_TTL_MS
}

/**
 * 按应用可见的通讯录刷新映射。
 * 返回 { ok, mapped, hint }:读不到人时 hint 说明要去哪配数据权限(不抛错,不影响同步)。
 */
export async function refreshPersonMap(): Promise<{
  ok: boolean
  mapped: number
  names: string[]
  hint?: string
  error?: string
}> {
  const scope = await getContactScope()
  if (!scope.ok) {
    personLog.warn('通讯录读取失败: ' + scope.error)
    return { ok: false, mapped: 0, names: [], error: scope.error }
  }
  const map: Record<string, string> = {}
  for (const u of scope.data.users) {
    const name = (u.name ?? '').trim()
    // 同名只保留第一个:宁可不写,也不写错人
    if (name && !map[name]) map[name] = u.openId
  }
  setConfig(CFG_MAP, JSON.stringify(map))
  setConfig(CFG_MAP_AT, String(Date.now()))
  const names = Object.keys(map)
  const idLike = names.filter((n) => /^ou_/.test(n)).length
  const hint = scope.data.empty
    ? '应用的通讯录可见范围为空:到开放平台「权限管理 → 数据权限」把通讯录可见范围设为全部员工或指定部门,再回来刷新'
    : idLike === names.length && names.length > 0
      ? '只读到了 open_id、读不到姓名:开放平台补上 contact:user.base:readonly(并发布版本)后重试;也可以直接在下面手工写「称呼=open_id」'
      : undefined
  return { ok: true, mapped: names.length, names, hint }
}
