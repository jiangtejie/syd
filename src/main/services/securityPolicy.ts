/**
 * 安全与数据落盘治理的**纯判定**（零依赖，可离线自检）。
 *
 * 这里集中两类「判错了就是数据泄露或误删」的规则：
 * 1. 哪些 app_config 键属于敏感值（落库前必须加封、不得明文回传渲染层）；
 * 2. 注入截图该不该清理。
 */

/** 固定键名的敏感配置 */
export const SECRET_CONFIG_KEYS: readonly string[] = [
  'ai.apiKey',
  'growth.image.apiKey',
  'growth.search.apiKey',
  'lark.appSecret'
]

/**
 * 带账号后缀的敏感键**只能按前缀认**：键名形如 `img:<wxid>:xorKey`，wxid 事前不知道，
 * 列不全 —— 这正是图片解密密钥一直是明文落库的原因（它不在 SECRET_KEYS 名单里）。
 */
export const SECRET_CONFIG_PREFIXES: readonly string[] = ['img:']

export function isSecretConfigKey(key: string): boolean {
  const k = (key ?? '').trim()
  if (!k) return false
  if (SECRET_CONFIG_KEYS.includes(k)) return true
  return SECRET_CONFIG_PREFIXES.some((p) => k.startsWith(p))
}

/** 注入过程截图的命名（injector.ts 写的就是这个形状） */
export const INJECT_SHOT_PREFIX = 'wx-'
export const INJECT_SHOT_EXT = '.png'

export function isInjectShot(name: string): boolean {
  const n = (name ?? '').trim().toLowerCase()
  return n.startsWith(INJECT_SHOT_PREFIX) && n.endsWith(INJECT_SHOT_EXT)
}

export interface ShotPruneInput {
  name: string
  /** 距现在的毫秒数（调用方用 mtime 算） */
  ageMs: number
  /** 保留天数；<=0 表示不按时间清理 */
  keepDays: number
  /** 在「按 mtime 倒序」的候选列表里的下标（0 = 最新） */
  index: number
  /** 最多保留几张；<=0 表示不按数量清理 */
  keepFiles: number
}

/**
 * 该删吗。
 *
 * 关键一条：**非截图永不删**。同目录里的 `wx-phase.txt` 是注入过程的状态标记，
 * 用于区分「一个字都还没输入」与「回车已经按下」——删了会让「状态未知绝不自动重试」的判定失效，
 * 后果是重复发送。清理逻辑只碰截图本身。
 */
export function shouldPruneInjectShot(input: ShotPruneInput): boolean {
  if (!isInjectShot(input.name)) return false
  if (input.keepDays > 0 && input.ageMs > input.keepDays * 86_400_000) return true
  if (input.keepFiles > 0 && input.index >= input.keepFiles) return true
  return false
}
