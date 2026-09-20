import { readFileSync, writeFileSync } from 'fs'
const files = [
  'src/main/services/wechat/crypto/sqlcipher.ts',
  'src/main/services/wechat/decrypt.ts',
  'src/renderer/src/components/settings/WechatKeySection.tsx',
  'src/renderer/src/pages/export.css',
  'src/renderer/src/pages/growth/buzz.css',
  'src/renderer/src/pages/growth/forms.css',
  'src/renderer/src/pages/growth/panels.css',
  'src/renderer/src/pages/growth/polish.css',
  'src/renderer/src/pages/growth/tables.css',
  'src/renderer/src/pages/growth-ai.css'
]
// 仓库里 committed 的内容是 LF（.prettierrc 未设 endOfLine → 默认 lf），但 core.autocrlf=true
// 会在 checkout 时把工作区写成 CRLF —— 这些文件就是这么变 CRLF 的（一次 git checkout 的副作用）。
// 统一转回 LF：既让 eslint/prettier 干净，也不改变 git 里存的内容（autocrlf 会在 add 时再归一）。
for (const f of files) {
  const src = readFileSync(f, 'utf8')
  const n = (src.match(/\r\n/g) || []).length
  if (n === 0) { console.log(f + ' 已是 LF'); continue }
  writeFileSync(f, src.split('\r\n').join('\n'))
  console.log(f + ' CRLF→LF (' + n + ' 行)')
}
