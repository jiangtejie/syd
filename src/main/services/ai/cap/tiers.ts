import { isWriteCap } from './registry'

/**
 * 飞书指令的权限分级(谁能查 / 谁能写 / 谁能代发微信)。
 *
 * - 档位:viewer(只读)< operator(可写业务数据)< admin(含代发微信 send_message);
 * - 归属:工作台页/对话页等本地入口不受限(tier=undefined = 不限制);
 *   飞书/IM 会话按「设置 → IM 渠道 → 命令权限名单」判定,白名单内默认 operator;
 * - 判定:工具所需档位 = send(send_message) / write(任何写类能力) / read(其余)。
 */

export type CapTier = 'viewer' | 'operator' | 'admin'

export const TIER_TEXT: Record<CapTier, string> = {
  viewer: '只读',
  operator: '可写业务数据',
  admin: '全部(含代发微信)'
}

const RANK: Record<CapTier, number> = { viewer: 1, operator: 2, admin: 3 }

export function parseCapTier(raw: string | undefined): CapTier | undefined {
  const t = (raw ?? '').trim().toLowerCase()
  if (t === 'viewer' || t === 'read' || t === '只读') return 'viewer'
  if (t === 'operator' || t === 'write' || t === '操作' || t === '可写') return 'operator'
  if (t === 'admin' || t === 'all' || t === '管理' || t === '全部') return 'admin'
  return undefined
}

/** 工具名 → 所需最低档位 */
export function requiredTierOf(toolName: string): CapTier {
  if (toolName === 'send_message') return 'admin'
  return isWriteCap(toolName) ? 'operator' : 'viewer'
}

/** 该档位是否可用某工具;tier 为 undefined(本地入口)表示不限制 */
export function allowedByTier(toolName: string, tier: CapTier | undefined): boolean {
  if (!tier) return true
  return RANK[tier] >= RANK[requiredTierOf(toolName)]
}

/* ── 会话 → 档位(进程内;IM 会话在每次入站时写入) ── */

const sessionTier = new Map<number, CapTier>()

export function setSessionCapTier(sessionId: number, tier: CapTier | undefined): void {
  if (tier) sessionTier.set(sessionId, tier)
  else sessionTier.delete(sessionId)
}

export function getSessionCapTier(sessionId: number): CapTier | undefined {
  return sessionTier.get(sessionId)
}

export function dropSessionCapTier(sessionId: number): void {
  sessionTier.delete(sessionId)
}

/** 权限不足时的可行动提示(给模型/用户看) */
export function tierDeniedText(toolName: string, tier: CapTier): string {
  const need = requiredTierOf(toolName)
  return (
    `当前飞书账号权限为「${TIER_TEXT[tier]}」,不能执行需要「${TIER_TEXT[need]}」的操作(${toolName})。` +
    '如需放开,请联系管理员在 设置 → IM 渠道 → 编辑飞书账号 → 命令权限名单 中调整。'
  )
}
