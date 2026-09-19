/**
 * 外观主题自检（纯函数 + CSS 契约，不联网、不碰库）。
 *
 * 钉住两件事：
 *  ① 主题解析口径：light/dark/system → 实际主题。两端（主进程 nativeTheme、渲染端 data-theme）
 *     必须用同一份口径，否则会出现"窗口底色深、界面还是浅色"的撕裂；
 *  ② 深色主题必须覆盖**关键语义令牌**：少覆盖一个，那一处就会在深色下留着浅色底
 *     （例如漏了 --bg-panel 就是白卡片糊在黑底上）。
 */
import { buildSync } from 'esbuild'
import { createRequire } from 'module'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

const require = createRequire(import.meta.url)
const root = join(dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..')
const work = mkdtempSync(join(tmpdir(), 'dsh-theme-'))

let failed = 0
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  ✔ ' : '  ✖ ') + label + (extra ? ' — ' + extra : ''))
  if (!cond) failed++
}

try {
  const bundle = join(work, 'theme.cjs')
  buildSync({
    entryPoints: [join(root, 'src/shared/theme.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle
  })
  const { resolveTheme, normalizeThemeMode } = require(bundle)

  console.log('主题解析：')
  ok(resolveTheme('light', true) === 'light', '浅色偏好 → 浅色（即使系统是深色）')
  ok(resolveTheme('dark', false) === 'dark', '深色偏好 → 深色（即使系统是浅色）')
  ok(resolveTheme('system', true) === 'dark', '跟随系统 + 系统深色 → 深色')
  ok(resolveTheme('system', false) === 'light', '跟随系统 + 系统浅色 → 浅色')
  ok(normalizeThemeMode('DARK') === 'system', '脏值归一到 system（大小写不敏感地拒绝未知值）')
  ok(normalizeThemeMode(null) === 'system' && normalizeThemeMode(1) === 'system', '非字符串一律回落 system')

  console.log('深色主题的 CSS 契约：')
  const css = readFileSync(join(root, 'src/renderer/src/assets/base.css'), 'utf8')
  const start = css.indexOf("[data-theme='dark']")
  ok(start > 0, "base.css 里有 [data-theme='dark'] 覆盖块")
  const block = start > 0 ? css.slice(start, css.indexOf('}', start)) : ''
  const MUST = [
    '--text-1', '--text-2', '--text-3', '--text-4', '--text-strong', '--placeholder',
    '--border', '--border-light', '--border-strong',
    '--bg', '--bg-panel', '--bg-hover', '--bg-sunken', '--bg-mask',
    '--brand-soft', '--brand-line',
    '--success-soft', '--danger-soft', '--danger-text', '--warn-soft', '--warn-text', '--info-soft',
    '--hover-sheen', '--badge-sheen', '--shadow-card', '--sb-thumb'
  ]
  const missing = MUST.filter((t) => !block.includes(t + ':'))
  ok(missing.length === 0, '关键语义令牌都被深色覆盖（' + String(MUST.length) + ' 项）', missing.join(', '))
  ok(/color-scheme:\s*dark/.test(block), '声明 color-scheme: dark（原生控件跟着变深）')
} finally {
  try {
    rmSync(work, { recursive: true, force: true })
  } catch {
    /* Windows 偶发占用 */
  }
}

console.log(failed === 0 ? '\n全部通过 ✅' : '\n' + String(failed) + ' 项失败 ❌')
process.exit(failed === 0 ? 0 : 1)
