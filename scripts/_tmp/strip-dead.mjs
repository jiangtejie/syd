import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
// 删掉已无引用的弹层/空态样式（迁移到 ui 基元后留下的壳）
const targets = {
  'src/renderer/src/pages/growth-ai.css': ['.gai-pick-mask {', '.gai-pick {', '.gai-pick-head {', '.gai-pick-head .t {', '.gai-pick-head .s {'],
  'src/renderer/src/pages/growth/buzz.css': ['.gth-buzz-modal {'],
  'src/renderer/src/pages/growth/tables.css': ['.gth-empty {', '.gth-empty .step {', '.gth-empty .step .no {', '.gth-empty .steps {'],
  'src/renderer/src/pages/growth/forms.css': ['.gth-error {', '.gth-error .msg {']
}
function stripBlock(css, selector) {
  const i = css.indexOf(selector)
  if (i < 0) return { css, removed: false }
  const end = css.indexOf('}', i)
  if (end < 0) return { css, removed: false }
  let s = i
  // 连同紧邻的前置注释一起删（注释只描述这一块）
  const before = css.lastIndexOf('/*', i)
  if (before >= 0 && css.slice(before, i).indexOf('*/') > 0 && i - before < 400) s = before
  return { css: css.slice(0, s) + css.slice(end + 1), removed: true }
}
for (const [f, sels] of Object.entries(targets)) {
  let t = readFileSync(f, 'utf8')
  let n = 0
  for (const s of sels) {
    // 反复删：同一选择器可能有多条规则（基础层 + 收尾覆盖层）
    for (let k = 0; k < 4; k++) {
      const r = stripBlock(t, s)
      if (!r.removed) break
      t = r.css
      n++
    }
  }
  writeFileSync(f, t)
  console.log(f.split('/').pop() + ' 删除 ' + n + ' 条规则')
}
