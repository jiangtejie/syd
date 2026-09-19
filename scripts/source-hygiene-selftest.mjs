/**
 * 源码卫生自检（纯文本扫描，不联网、不碰库）。
 *
 * 为什么需要：这些问题的**症状都不明显**，而且已经在这两个上各踩过一次：
 *  ① **中文乱码**：用 PowerShell 的 Get-Content/Set-Content 批量改带中文的源码时，UTF-8 会被按 GBK
 *     解码再写成 UTF-8（满屏「锛?鐨?」），且部分字符不可逆 —— 七个 CSS 文件整片废掉，只能 git 回滚重做。
 *  ② **行尾混入 CRLF**：仓库里存的是 LF（.prettierrc 未设 endOfLine → 默认 lf），但
 *     core.autocrlf=true 会在 checkout 时把工作区写成 CRLF，于是 eslint/prettier 一口气报几百条
 *     「Delete ␍」；更麻烦的是同一文件里混着两种行尾时 diff 会整片变色。
 *  ③ **字号硬编码回潮**：全仓字号已收敛到 assets/base.css 的 --fs-* 六档（见 ARCHITECTURE 的排版口径），
 *     只剩两处图标字形是写死的；不加断言的话，下一轮随手写 font-size: 13px 就会悄悄回潮。
 *
 * 用法：node scripts/source-hygiene-selftest.mjs（已挂进 npm run test:all）
 */
import { readdirSync, readFileSync, statSync } from 'fs'
import { dirname, join, relative } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCAN_DIRS = ['src', 'scripts']
const EXTS = ['.css', '.ts', '.tsx', '.mjs', '.js', '.json', '.md', '.html']

/** 乱码特征字：UTF-8 被按 GBK 读过的产物里高频出现，正常中文技术文档几乎不会用到 */
const MOJIBAKE = [
  '锛', '鐨', '鈥', '銆', '鍜', '鏄', '涓', '瑙', '瘑', '灞', '傛', '彁', '绀', '鏂', '浠',
  '婧', '鍥', '鐣', '鏍', '瀹', '鎴', '绾', '缂', '鍏', '閰', '閲', '鐜', '鍣', '鐢', '鎬',
  '鐞', '鎵', '缁', '鍒', '鍗', '鍐', '鎶', '鎻', '鐗', '鏉', '鐩', '鐪', '鎰', '瀵', '娴',
  '鐐', '鐔', '鐫', '鏂', '鐨'
]

/** 允许写死字号的例外：图标字形（不是文字排版，值也大于任何正文档） */
const FONT_PX_ALLOW = 4

let failed = 0
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  ✔ ' : '  ✖ ') + label + (extra ? ' — ' + extra : ''))
  if (!cond) failed++
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === '.git' || name === 'out' || name === '_tmp') continue
      walk(p, out)
    } else if (EXTS.some((e) => name.endsWith(e))) {
      // 跳过本文件：它的乱码特征字表本身就是这些字符，会被自己命中
      if (name === 'source-hygiene-selftest.mjs') continue
      out.push(p)
    }
  }
  return out
}

const files = SCAN_DIRS.flatMap((d) => {
  try {
    return walk(join(root, d))
  } catch {
    return []
  }
})

console.log('\n扫描范围：' + files.length + ' 个文件（' + SCAN_DIRS.join(' / ') + '）')

console.log('\n[1] 中文乱码（UTF-8 被按 GBK 读过的痕迹）')
{
  const hits = []
  for (const f of files) {
    const t = readFileSync(f, 'utf8')
    for (const c of MOJIBAKE) {
      const n = t.split(c).length - 1
      if (n > 0) hits.push(relative(root, f) + ' ×' + String(n) + '（' + c + '）')
    }
  }
  ok(hits.length === 0, '没有乱码特征字', hits.slice(0, 5).join(' ; '))
  if (hits.length > 0) {
    console.log('    修法：别用 PowerShell 的 Get-Content/Set-Content 改这些文件，用 Node 读写（UTF-8 安全）')
  }
}

console.log('\n[2] 行尾：仓库存 LF，工作区不该混入 CRLF')
{
  const hits = []
  for (const f of files) {
    const buf = readFileSync(f)
    if (buf.includes(13)) hits.push(relative(root, f) + '（' + String((buf.toString('utf8').match(/\r\n/g) || []).length) + ' 行）')
  }
  ok(hits.length === 0, '没有 CRLF 文件', hits.slice(0, 5).join(' ; '))
  if (hits.length > 0) {
    console.log('    成因：core.autocrlf=true 在 git checkout 时会把工作区写成 CRLF；转回 LF 即可')
  }
}

console.log('\n[3] 字号必须走 --fs-* 六档（assets/base.css 定义）')
{
  const hits = []
  for (const f of files) {
    if (!f.endsWith('.css')) continue
    const t = readFileSync(f, 'utf8')
    const n = (t.match(/font-size:\s*[0-9.]+px/g) || []).length
    if (n > 0) hits.push(relative(root, f) + ' ×' + String(n))
  }
  const total = hits.reduce((s, h) => s + Number(h.split('×')[1]), 0)
  ok(total <= FONT_PX_ALLOW, '写死的 font-size 不超过 ' + String(FONT_PX_ALLOW) + ' 处（图标字形）', hits.join(' ; ') || '0 处')
}

console.log(failed === 0 ? '\n全部通过 ✅' : '\n' + String(failed) + ' 项未通过 ❌')
process.exit(failed === 0 ? 0 : 1)
