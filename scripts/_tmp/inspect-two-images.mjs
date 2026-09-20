/** 两张图到底是什么：文件头解析尺寸 + 媒体目录实况 + source_mark 取值分布 */
import Database from 'better-sqlite3-multiple-ciphers'
import { copyFileSync, existsSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const appData = process.env.APPDATA || ''
const mediaRoot = join(appData, 'wechat-cs-desktop')

// 只读导出：source_mark 分布
const work = tmpdir()
const src = join(mediaRoot, 'cs.db')
const tmpDb = join(work, 'cs-shape-' + Date.now() + '.db')
copyFileSync(src, tmpDb)
const db = new Database(tmpDb, { readonly: true })
console.log('== source_mark 分布 ==')
for (const r of db.prepare('SELECT source_mark, kind, COUNT(*) c FROM growth_asset GROUP BY source_mark, kind ORDER BY c DESC').all()) console.log(JSON.stringify(r))
db.close()

function pngSize(buf) {
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}
function webpSize(buf) {
  const fmt = buf.toString('ascii', 12, 16)
  if (fmt === 'VP8X') return { fmt, w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) }
  if (fmt === 'VP8 ') return { fmt, w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff }
  if (fmt === 'VP8L') {
    const b = buf.readUInt32LE(21)
    return { fmt, w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 }
  }
  return { fmt }
}
console.log('')
console.log('== 两张图的真实尺寸/大小 ==')
for (const rel of ['dc/dc376cdb3f226b5119c8465276f65604506a4e22.webp', '20/209abb19ef36b859c00f0a3d881dc9182659bf86.png']) {
  // 媒体根目录由主进程 paths.ts 决定，这里按常见位置找
  const cands = ['growth-media', 'media', 'growth'].map((d) => join(mediaRoot, d, rel))
  const hit = cands.find((p) => existsSync(p))
  if (!hit) {
    console.log(rel, '未找到；候选：', cands.join(' | '))
    continue
  }
  const buf = readFileSync(hit)
  const size = statSync(hit)
  const dim = rel.endsWith('.png') ? pngSize(buf) : webpSize(buf)
  console.log(rel, '→', JSON.stringify(dim), Math.round(size.size / 1024) + 'KB', size.mtime.toLocaleString('zh-CN', { hour12: false }))
}
console.log('')
console.log('== userData 下的一级目录 ==')
for (const d of readdirSync(mediaRoot)) {
  const p = join(mediaRoot, d)
  try { if (statSync(p).isDirectory()) console.log(' ', d) } catch { /* ignore */ }
}
