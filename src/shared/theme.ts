/**
 * 外观主题的**纯判定**（零依赖，可离线自检）。
 *
 * 放 shared 是因为两端都要用同一个口径：主进程写 nativeTheme、渲染端写 <html data-theme>；
 * 两边对"system 解析成什么"必须一致，否则会出现"窗口底色是深色、界面还是浅色"这种撕裂。
 */
export type ThemeMode = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

/** 主题偏好 → 实际主题（system 以系统为准） */
export function resolveTheme(mode: ThemeMode, systemDark: boolean): ResolvedTheme {
  if (mode === 'light') return 'light'
  if (mode === 'dark') return 'dark'
  return systemDark ? 'dark' : 'light'
}

/** 归一化外部输入（localStorage 里的脏值、IPC 参数） */
export function normalizeThemeMode(v: unknown): ThemeMode {
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system'
}

/** 把解析结果写到 <html>：业务 CSS 只认 [data-theme='dark'] 这一段覆盖 */
export function applyResolved(theme: ResolvedTheme): void {
  const root = document.documentElement
  if (theme === 'dark') root.dataset.theme = 'dark'
  else delete root.dataset.theme
}
