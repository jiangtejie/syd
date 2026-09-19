import type { ThemeMode } from '../../../shared/theme'
import { applyResolved, normalizeThemeMode, resolveTheme } from '../../../shared/theme'

/**
 * 外观主题（浅色 / 深色 / 跟随系统）。
 *
 * 为什么放 localStorage 而不是 app_config：它是**这台机器的显示偏好**，与"当前页面 / 监控页签"同类
 * （见 stores/workbench 的 PAGE_KEY）；跟着数据库走会让换账号时莫名其妙换主题。
 *
 * 两条链路各管一半，取值口径共用 shared/theme.ts（纯函数，有自检）：
 *  - 主进程：nativeTheme.themeSource + 窗口底色 —— 切主题瞬间不会先闪一下白；
 *  - 渲染端：<html data-theme> —— 业务 CSS 只认语义令牌，一行都不用改。
 * 「跟随系统」以 matchMedia 为准：nativeTheme 设成 system 后，该媒体查询本身就反映系统设置。
 *
 * 注：本文件叫 appearance 而不是 theme —— lib/theme.ts 已经是图表配色的地盘。
 */
const KEY = 'cs.theme'

export function readThemeMode(): ThemeMode {
  try {
    return normalizeThemeMode(localStorage.getItem(KEY))
  } catch {
    return 'system'
  }
}

function systemDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return false
  }
}

/** 应用并持久化；主进程侧同步 nativeTheme（失败不拦，界面照旧生效） */
export function setThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(KEY, mode)
  } catch {
    /* 隐私模式等场景下写不了，仅本次生效 */
  }
  applyResolved(resolveTheme(mode, systemDark()))
  void window.api?.cs?.app?.setTheme?.(mode)
}

/** 启动时调用一次：按已保存的偏好落地，并挂上"系统主题变化"的监听 */
export function initTheme(): () => void {
  setThemeMode(readThemeMode())
  let mq: MediaQueryList | null = null
  try {
    mq = window.matchMedia('(prefers-color-scheme: dark)')
  } catch {
    return () => undefined
  }
  const onChange = (): void => {
    if (readThemeMode() === 'system') applyResolved(resolveTheme('system', systemDark()))
  }
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}
