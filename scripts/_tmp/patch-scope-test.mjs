import { readFileSync, writeFileSync } from 'node:fs'
const p = 'scripts/growth-image-strategy-selftest.mjs'
let s = readFileSync(p, 'utf8')
const before = (s.match(/mode: 'edit',/g) || []).length
// 旧的 edit 断言测的是「同款重构」口径（现在它是显式选项，不再是默认）→ 显式加上 editScope
s = s.replace(/mode: 'edit',(?!\s*\n\s*editScope)/g, "mode: 'edit',\n    editScope: 'restructure',")
const after = (s.match(/editScope: 'restructure'/g) || []).length
writeFileSync(p, s, 'utf8')
console.log('mode: edit 出现', before, '次；已标注 restructure', after, '处')
