/**
 * 生成 out/renderer/preview.html：在真实构建产物上注入 window.api 桩，用于在浏览器里做 UI 评审。
 * 每次 npm run build 会清空 out/，所以评审前重跑一次本脚本即可。
 *
 * 两处预览专用改写（只落在 out/ 里，不动源码）：
 *  1. 注入 mock.js（window.api 桩 + 自定义协议图片替换）；
 *  2. 把演示账号 'wxid_demo' 换成 'wxid_jiangyanjing' —— 渲染端用「wxid !== 'wxid_demo'」判断
 *     「是否已连接真实账号」，不换的话「数据 / 监控」页只会显示「尚未连接微信」，看不到真实排版。
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
// 可选入参：构建产物目录（默认 out/renderer）。
// 用途：dev 模式在跑时 out/renderer 是空的，可以另构建一份到 out-preview 再生成预览，不打扰正在跑的实例。
const outDir = process.argv[2] ? resolve(process.argv[2]) : join(root, 'out', 'renderer')
const index = join(outDir, 'index.html')
if (!existsSync(index)) {
  console.error('缺少构建产物：先跑 npx electron-vite build')
  process.exit(1)
}
copyFileSync(join(here, 'mock.js'), join(outDir, 'mock.js'))

let html = readFileSync(index, 'utf8')
html = html.replace('<head>', '<head>\n    <script src="./mock.js"></script>')

// 只改「对话页初始化时的兜底账号」这一处：各页的「是否已连接」判据是 wxid !== 'wxid_demo'，
// 把判据本身也改掉就永远连不上了（踩过）。store 拿到真实形状的 wxid 后，各页判据自然放行。
const assetsDir = join(outDir, 'assets')
const FROM = 'init(wxid || "wxid_demo")'
const TO = 'init(wxid || "wxid_jiangyanjing")'
let patchedFiles = 0
for (const name of readdirSync(assetsDir)) {
  if (!name.endsWith('.js')) continue
  const file = join(assetsDir, name)
  const src = readFileSync(file, 'utf8')
  if (!src.includes(FROM)) continue
  writeFileSync(file, src.split(FROM).join(TO))
  patchedFiles++
}
console.log('已改写 ' + patchedFiles + ' 个 chunk（' + FROM + ' → ' + TO + '）')
// 注意：**不要**给入口加 ?v= 之类的查询串 —— 懒加载 chunk 里 import 的是 './index-xxx.js'，
// 加了查询串会让浏览器把它当另一个模块再加载一份，等于两份 React（症状是 React #321 invalid hook call，
// 且只在懒加载页面复现）。静态服务器已经发了 no-store，不需要靠查询串破缓存。
writeFileSync(join(outDir, 'preview.html'), html)
console.log('preview.html 已生成：' + join(outDir, 'preview.html'))
