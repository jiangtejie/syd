/**
 * 发送前的目标校验与发送后文本比对（**纯函数**，可自检）。
 *
 * 为什么必须有这一层：发消息靠「微信搜索框粘会话名 → 回车」打开会话，
 * 而回车打开的是**第一个匹配结果** —— 群名重名/前缀相同/改名时会直接发进错群，发出去收不回。
 * 这里在注入之前把「这次搜索会不会命中别的会话」判掉；判定完全离线，便于回归。
 */

export interface GuardSession {
  username: string
  displayName: string
}

/** 微信搜索框对超长会话名会截断，所以注入用的搜索词也截断到 30 字（与 injector 保持一致） */
export const SEARCH_MAX = 30

export interface TargetDecision {
  ok: boolean
  /** 实际用于注入的会话名（优先取会话列表里的真实展示名） */
  name: string
  error?: string
  /** 通过时的说明（写日志，便于事后复盘） */
  note?: string
}

/** 归一化会话名：去空白/零宽字符，统一全角空格 */
export function normalizeName(name: string): string {
  return (name || '')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/[\s\u3000]+/g, ' ')
    .trim()
}

/** 注入用的搜索词（与 injector.ts 的截断口径一致） */
export function searchKey(name: string): string {
  const n = normalizeName(name)
  return n.length > SEARCH_MAX ? n.slice(0, SEARCH_MAX) : n
}

/**
 * 选择要发送的目标会话名，并判断「这次搜索唯一吗」。
 *
 * 判定规则（任一命中即拒绝，宁可让人手动发，也不能发错群）：
 * 1. 存在**同名**会话（归一化后完全一致，但不是同一个会话）；
 * 2. 存在**截断后撞车**的会话（前 30 字相同，如两个长名群共享前缀）；
 * 3. 存在**包含关系**的会话（别的会话名包含搜索词，或搜索词包含别的会话名）——
 *    微信搜索是模糊匹配，这种最容易误命中；短名群（如「宜家」）尤其危险。
 */
export function pickUniqueTarget(
  sessions: GuardSession[],
  sessionId: string,
  requestedName: string
): TargetDecision {
  const key = searchKey(requestedName)
  if (!key) return { ok: false, name: requestedName, error: '会话名为空，无法定位目标会话' }

  const hit = sessions.find((s) => s.username === sessionId)
  const resolved = normalizeName(hit?.displayName || '') || normalizeName(requestedName)
  const keyOfResolved = searchKey(resolved)
  const others = sessions.filter((s) => s.username !== sessionId)

  const sameName = others.filter((s) => normalizeName(s.displayName) === resolved)
  if (sameName.length > 0) {
    return {
      ok: false,
      name: resolved,
      error: `有 ${sameName.length} 个同名会话（${sameName
        .slice(0, 3)
        .map((s) => s.displayName)
        .join('、')}），搜索会命中第一个 —— 为避免发错群，请手动发送或先给会话改名`
    }
  }

  const prefixClash = others.filter((s) => searchKey(s.displayName) === keyOfResolved)
  if (prefixClash.length > 0) {
    return {
      ok: false,
      name: resolved,
      error: `会话名前 ${SEARCH_MAX} 字与其它会话相同（${prefixClash
        .slice(0, 3)
        .map((s) => s.displayName)
        .join('、')}），搜索无法区分 —— 请手动发送`
    }
  }

  const contained = others.filter((s) => {
    const n = normalizeName(s.displayName)
    if (!n) return false
    return n.includes(keyOfResolved) || keyOfResolved.includes(n)
  })
  if (contained.length > 0) {
    return {
      ok: false,
      name: resolved,
      error: `搜索词「${keyOfResolved}」可能命中别的会话（${contained
        .slice(0, 3)
        .map((s) => s.displayName)
        .join('、')}）—— 请手动发送或给会话改名`
    }
  }

  return {
    ok: true,
    name: keyOfResolved,
    note: hit
      ? '目标会话在当前列表中且搜索唯一'
      : '目标会话不在当前列表（可能刚建/已改名），按搜索唯一性放行'
  }
}

/** 发送后比对的归一化：去空白与零宽字符，只比前 80 字（微信可能截断/换行） */
export function normalizeForCompare(text: string): string {
  return (text || '')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, '')
    .slice(0, 80)
}

/** 库里最近的我方消息是否就是这条（双向包含，容忍前缀/尾注差异） */
export function textMatchesSent(outgoing: string, sent: string): boolean {
  const a = normalizeForCompare(outgoing)
  const b = normalizeForCompare(sent)
  if (!a || !b) return false
  return a.includes(b) || b.includes(a)
}
