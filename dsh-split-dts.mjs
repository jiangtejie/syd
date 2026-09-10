import fs from 'fs'
const dtsPath = 'src/preload/index.d.ts'
const src = fs.readFileSync(dtsPath, 'utf8')
const lines = src.split(/\r?\n/)

const start = lines.findIndex((l) => l === '      cs: {')
if (start < 0) throw new Error('cs: { not found')
let depth = 0
let end = -1
for (let i = start; i < lines.length; i++) {
  for (const ch of lines[i]) {
    if (ch === '{') depth++
    else if (ch === '}') depth--
  }
  if (depth === 0 && i > start) { end = i; break }
}
if (end < 0) throw new Error('cs block end not found')
const body = lines.slice(start + 1, end)
const head = lines.slice(0, lines.findIndex((l) => l === 'declare global {'))

// 共享接口文件：imports 路径从 ../shared/x 改成 ./x，辅助类型保持原样导出
const headOut = head
  .map((l) => l.replace("'../shared/types'", "'./types'").replace("'../shared/growth'", "'./growth'"))
  .join('\n')
  .replace(/^interface KeyActionResult \{/m, 'export interface KeyActionResult {')
  .replace(/^type Result<T> =/m, 'export type Result<T> =')
  .replace(/^type AiReplyResult = \{/m, 'export type AiReplyResult = {')

const apiFile = `${headOut}

/**
 * 主进程 ↔ 渲染端桥接口(cs 命名空间)的**唯一真源**。
 *
 * 为什么放在 shared:preload 实现以 \`const api: CsApi\` 对着它编译,渲染端 window.api 也用它,
 * 因此「实现加了方法但声明忘了同步」「声明的参数与实现不一致」都会直接编译失败,
 * 不会再出现类型漂移(历史上就漏同步过 mergeDuplicates/archiveStale)。
 */
export interface CsApi {
${body.map((l) => (l.startsWith('    ') ? l.slice(4) : l)).join('\n')}
}
`
fs.writeFileSync('src/shared/api.ts', apiFile)

const dtsOut = `import type { ElectronAPI } from '@electron-toolkit/preload'
import type { CsApi } from '../shared/api'

/**
 * 渲染端 window.api 声明(仅声明,实体在 src/preload/index.ts)。
 * 桥接口的真源见 src/shared/api.ts —— 这里不再重复维护方法签名。
 */
declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      cs: CsApi
    }
  }
}
`
fs.writeFileSync(dtsPath, dtsOut)
console.log('cs body lines', body.length, '| api.ts bytes', apiFile.length, '| d.ts lines', dtsOut.split('\n').length)
