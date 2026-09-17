/**
 * 首启与落地页的**纯判定**（零依赖，可离线自检）。
 *
 * 为什么值得单独钉住：
 * - 落地页以前是「左侧导航第一项」= AI 工作台，而**对话排第三** —— 客服装完先看到一个空聊天框，
 *   没有人告诉他下一步做什么；
 * - 最硬的一步（64 位数据库密钥）在应用外，代码里明确写着「自动获取已停用」，
 *   首日流失就发生在这一屏。所以「什么时候该弹向导、弹第几步」必须是确定行为，不能靠感觉。
 */

/** 应用外壳的页面键（与 stores/workbench.ts 的 WorkbenchPage 保持一致） */
export const PAGE_IDS = [
  'workbench',
  'monitor',
  'chat',
  'customers',
  'duty',
  'settings',
  'export',
  'growth'
] as const

export type PageId = (typeof PAGE_IDS)[number]

/** 历史别名：'dashboard' 现在落到「监控 · 运营看板」页签，不是独立页面 */
export const LEGACY_PAGE_ALIASES: Record<string, PageId> = { dashboard: 'monitor' }

export function isValidPage(v: unknown): v is PageId {
  return typeof v === 'string' && (PAGE_IDS as readonly string[]).includes(v)
}

/**
 * 启动落在哪一页。
 *
 * - 记住过 → 用记住的（用户上次停在哪就停在哪）；
 * - 没记住 / 值不认识（首启、清过存储、版本变更） → **对话**：
 *   客服的主战场，先看到客户消息才算「用起来了」。
 */
export function resolveInitialPage(persisted: string | null | undefined): PageId {
  const raw = (persisted ?? '').trim()
  if (!raw) return 'chat'
  const alias = LEGACY_PAGE_ALIASES[raw]
  if (alias) return alias
  return isValidPage(raw) ? raw : 'chat'
}

export interface FirstRunInput {
  /** 用户点过「稍后再说」或走完过向导（app_config: onboarding.done） */
  done: boolean
  /** 探测到/已导入过的微信账号数 */
  accountCount: number
  /** 其中已导入密钥的账号数 */
  keyCount: number
}

export interface FirstRunState {
  show: boolean
  /** 1=找账号 2=导入密钥 3=可以开始用了 */
  step: 1 | 2 | 3
  title: string
  detail: string
  /** 主按钮文案 */
  action: string
}

/**
 * 该不该弹首启向导、弹到第几步。
 *
 * 只在**确实缺东西**时弹：已经有账号且有密钥的用户不该被再教一遍（哪怕他从没点过向导）。
 */
export function firstRunState(input: FirstRunInput): FirstRunState {
  const accountCount = Math.max(0, Math.floor(input?.accountCount ?? 0))
  const keyCount = Math.max(0, Math.floor(input?.keyCount ?? 0))
  if (input?.done || (accountCount > 0 && keyCount > 0)) {
    return { show: false, step: 3, title: '', detail: '', action: '' }
  }
  if (accountCount === 0) {
    return {
      show: true,
      step: 1,
      title: '先找到你的微信账号',
      detail:
        '应用需要你本机的微信数据目录。到「设置 → 微信数据与密钥」点一键接入，会自动找到账号目录。',
      action: '去设置'
    }
  }
  return {
    show: true,
    step: 2,
    title: '导入数据库密钥（唯一挡在门口的一步）',
    detail:
      '这一步在应用外：需要用外部工具从本机微信导出一个 64 位十六进制密钥，再粘贴进来。它必须能通过真实库校验才会被接受 —— 这是为了不让你拿着一把错钥匙反复试。',
    action: '去导入密钥'
  }
}

/** 向导步骤条的展示文案（界面与自检共用一份，避免两处各写一遍） */
export const FIRST_RUN_STEPS: readonly string[] = ['找到账号', '导入密钥', '开始使用']
