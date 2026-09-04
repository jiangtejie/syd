import { getChatCaps, setChatCaps, chatCapsPersisted } from '../../../db/repos/chatRepo'
import { listCaps } from './registry'

/**
 * 会话级能力挂载仓库(渐进式加载的“状态面”)。
 * - 持久化:chat_session.caps(JSON 名称数组),内存缓存会话轮次与最近使用轮;
 * - 新会话(从未持久化)自动写入“默认挂载”集:微信业务(L1,绑定账号);软件能力按需挂载;
 * - 预算:同时挂载项上限 MOUNT_MAX_ITEMS;说明文本总量在组装层软限(MOUNT_TEXT_BUDGET);
 * - 空闲回收:连续 IDLE_TURNS 轮未被调用的挂载项自动卸载(见 beginTurn)。
 */

export const MOUNT_MAX_ITEMS = 8
/** 组装层:挂载说明文本追加软上限(超限截断并提示) */
export const MOUNT_TEXT_BUDGET = 6000
/** 空闲回收:连续 N 轮未使用的挂载项自动卸载 */
const IDLE_TURNS = 2

interface SessionMounts {
  names: Set<string>
  /** 会话轮次(用于 lastUsed 比较) */
  turn: number
  /** 名称 → 最近使用轮次(undefined=挂载后尚未使用) */
  usedAt: Map<string, number>
  loaded: boolean
}

const mem = new Map<number, SessionMounts>()

function stateOf(sessionId: number): SessionMounts {
  let s = mem.get(sessionId)
  if (!s) {
    s = { names: new Set(), turn: 0, usedAt: new Map(), loaded: false }
    mem.set(sessionId, s)
  }
  return s
}

function persist(sessionId: number, s: SessionMounts): void {
  try {
    setChatCaps(sessionId, [...s.names])
  } catch {
    /* 会话可能刚被删除,忽略 */
  }
}

/** 新会话默认挂载集:仅绑定账号会话自动带 L1 微信业务工具 */
function defaultNames(bound: boolean): string[] {
  const out: string[] = []
  const caps = listCaps()
  if (bound) {
    for (const c of caps) {
      if (c.tier === 1 && !c.disabled) out.push(c.name)
    }
  }
  return [...new Set(out)]
}

/** 惰性装载:内存 → DB(用户态)→ 默认集(首次),并过滤已停用/不存在的名字 */
function ensureLoaded(sessionId: number, bound: boolean): SessionMounts {
  const s = stateOf(sessionId)
  if (s.loaded) return s
  s.loaded = true
  try {
    const persisted = chatCapsPersisted(sessionId)
    const caps = listCaps()
    const clean = (raw: string[]): string[] =>
      raw.filter((n) => {
        const cap = caps.find((c) => c.name === n)
        return !!cap && !cap.disabled
      })
    if (persisted) {
      s.names = new Set(clean(getChatCaps(sessionId)))
    } else {
      s.names = new Set(clean(defaultNames(bound)))
      persist(sessionId, s)
    }
  } catch {
    s.names = new Set()
  }
  return s
}

/** 当前挂载名(稳定排序) */
export function mountedNames(sessionId: number, bound: boolean): string[] {
  return [...ensureLoaded(sessionId, bound).names]
}

export function isMounted(sessionId: number, name: string, bound: boolean): boolean {
  return ensureLoaded(sessionId, bound).names.has(name)
}

/** 挂载:校验 已知/未停用/账号约束/预算;返回新增与逐条错误 */
export function mountCaps(
  sessionId: number,
  names: string[],
  opts: { bound: boolean }
): { added: string[]; errors: string[] } {
  const s = ensureLoaded(sessionId, opts.bound)
  const added: string[] = []
  const errors: string[] = []
  const caps = listCaps()
  for (const name of [...new Set(names)]) {
    const cap = caps.find((c) => c.name === name)
    if (!cap) {
      errors.push(`${name}:能力不存在,先调用 list_capabilities 查看目录`)
      continue
    }
    if (cap.disabled) {
      errors.push(`${name}:已停用(可在 技能 页重新启用)`)
      continue
    }
    if (cap.needsWx && !opts.bound) {
      errors.push(`${name}:需要绑定微信账号(当前会话未绑定)`)
      continue
    }
    if (cap.tier === 0 || s.names.has(name)) continue
    if (s.names.size >= MOUNT_MAX_ITEMS) {
      errors.push(`${name}:挂载预算已满(最多 ${MOUNT_MAX_ITEMS} 项),请先卸载不用的能力`)
      continue
    }
    s.names.add(name)
    s.usedAt.delete(name)
    added.push(name)
  }
  if (added.length > 0) persist(sessionId, s)
  return { added, errors }
}

/** 卸载;核心能力(L0)常驻不可卸载 */
export function unmountCaps(
  sessionId: number,
  names: string[],
  opts: { bound: boolean }
): { removed: string[]; errors: string[] } {
  const s = ensureLoaded(sessionId, opts.bound)
  const removed: string[] = []
  const errors: string[] = []
  for (const name of [...new Set(names)]) {
    if (s.names.delete(name)) {
      s.usedAt.delete(name)
      removed.push(name)
    } else if (listCaps().some((c) => c.name === name && c.tier === 0)) {
      errors.push(`${name}:核心能力常驻,无需且不可卸载`)
    } else {
      errors.push(`${name}:当前未挂载`)
    }
  }
  if (removed.length > 0) persist(sessionId, s)
  return { removed, errors }
}

/** 标记某能力本轮被调用(空闲回收依据;由执行层在真实工具调用后调用) */
export function markUsed(sessionId: number, name: string, bound: boolean): void {
  const s = ensureLoaded(sessionId, bound)
  s.usedAt.set(name, s.turn)
}

/** 每轮开始前推进轮次并回收空闲挂载,返回自动卸载名单 */
export function beginTurn(sessionId: number, bound: boolean): { dropped: string[] } {
  const s = ensureLoaded(sessionId, bound)
  s.turn += 1
  const dropped: string[] = []
  for (const name of [...s.names]) {
    const used = s.usedAt.get(name)
    if (used !== undefined && s.turn - used > IDLE_TURNS) {
      s.names.delete(name)
      s.usedAt.delete(name)
      dropped.push(name)
    }
  }
  if (dropped.length > 0) persist(sessionId, s)
  return { dropped }
}

/** 会话删除后释放内存缓存(下次同 id 不会再出现;autoincrement 不复用) */
export function dropSession(sessionId: number): void {
  mem.delete(sessionId)
}
