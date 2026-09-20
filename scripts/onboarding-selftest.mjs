import { buildSync } from 'esbuild'
import { createRequire } from 'module'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

/**
 * 首启与落地页判定自检（纯函数）。
 *
 * 钉住的事故形态：
 *  ① 落地页以前是「左侧导航第一项」= AI 工作台，而**对话排第三** —— 客服装完先看到一个空聊天框；
 *  ② 最硬的一步（64 位密钥）在应用外，没人告诉他下一步去哪；
 *  ③ 向导不能骚扰已经在用的人：有账号又有密钥就该闭嘴，哪怕他从没点过向导。
 */

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'dsh-onboarding-'))

let failed = 0
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  ✔ ' : '  ✖ ') + label + (extra ? ' — ' + extra : ''))
  if (!cond) failed++
}

try {
  const bundle = join(work, 'onboarding.cjs')
  buildSync({
    entryPoints: [join(root, 'src/shared/onboarding.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: bundle
  })
  const { resolveInitialPage, isValidPage, firstRunState, FIRST_RUN_STEPS, PAGE_IDS } = require(bundle)

  console.log('落地页：')
  ok(resolveInitialPage(null) === 'chat', '★ 首启（没记住过）落在「对话」，不是 AI 工作台')
  ok(resolveInitialPage(undefined) === 'chat', '★ undefined 同样落在「对话」')
  ok(resolveInitialPage('') === 'chat', '空串落在「对话」')
  ok(resolveInitialPage('monitor') === 'monitor', '记住过的页面照用（用户停在哪就是哪）')
  ok(resolveInitialPage('chat') === 'chat', '记住 chat')
  ok(resolveInitialPage('workbench') === 'workbench', '记住 AI 工作台也照用（不强行纠正用户）')
  ok(resolveInitialPage('dashboard') === 'monitor', '历史别名 dashboard → 监控')
  ok(resolveInitialPage('  chat  ') === 'chat', '两侧空白不影响')
  ok(resolveInitialPage('nonsense') === 'chat', '★ 认不出的值兜底到「对话」（不白屏）')
  ok(resolveInitialPage('settings') === 'settings', '设置页也能被记住')

  console.log('页面键校验：')
  ok(isValidPage('chat') === true && isValidPage('export') === true, '合法键')
  ok(isValidPage('growth') === false, '★ 营销页已下线，不再是合法页面键')
  ok(resolveInitialPage('growth') === 'chat', '★ 老用户记住的 growth 回落「对话」（不白屏）')
  ok(isValidPage('dashboard') === false, 'dashboard 是别名不是页面键')
  ok(isValidPage('') === false && isValidPage(null) === false && isValidPage(123) === false, '空值/非字符串安全')
  ok(Array.isArray(PAGE_IDS) && PAGE_IDS.length >= 7, '页面键清单非空', String(PAGE_IDS.length))

  console.log('首启向导该不该弹：')
  const done = firstRunState({ done: true, accountCount: 0, keyCount: 0 })
  ok(done.show === false, '点过「稍后再说」就不再弹')
  const ready = firstRunState({ done: false, accountCount: 1, keyCount: 1 })
  ok(ready.show === false, '★ 有账号又有密钥 → 不弹（哪怕从没点过向导）')
  const noAccount = firstRunState({ done: false, accountCount: 0, keyCount: 0 })
  ok(noAccount.show === true && noAccount.step === 1, '没找到账号 → 第 1 步')
  ok(noAccount.title.length > 0 && noAccount.detail.length > 0 && noAccount.action.length > 0, '第 1 步文案齐全（不出现空按钮）')
  const noKey = firstRunState({ done: false, accountCount: 2, keyCount: 0 })
  ok(noKey.show === true && noKey.step === 2, '有账号没密钥 → 第 2 步')
  ok(noKey.detail.includes('在应用外'), '★ 第 2 步说明白「这一步在应用外」（这是首日流失的那一屏）')
  const partial = firstRunState({ done: false, accountCount: 3, keyCount: 1 })
  ok(partial.show === false, '已有一个账号有密钥就算就绪（别人的账号不该被拖着走向导）')
  const weird = firstRunState({ done: false, accountCount: -5, keyCount: Number.NaN })
  ok(weird.show === true && weird.step === 1, '脏数值不炸（按 0 处理）')
  const empty = firstRunState({})
  ok(empty.show === true && empty.step === 1, '缺字段也不炸')
  ok(FIRST_RUN_STEPS.length === 3, '步骤条三步', String(FIRST_RUN_STEPS.length))
} finally {
  try { rmSync(work, { recursive: true, force: true }) } catch { /* Windows 偶发占用 */ }
}

console.log(failed === 0 ? '\n全部通过 ✅' : '\n' + failed + ' 项失败 ❌')
process.exit(failed === 0 ? 0 : 1)
