/** 两张图的实际格式与尺寸（读文件头，不依赖任何图像库） */
import { readFileSync, statSync } from 'node:fs'

function pngSize(b) { return { fmt: 'png', w: b.readUInt32BE(16), h: b.readUInt32BE(20) } }
function webpSize(b) {
  const fmt = b.toString('ascii', 12, 16)
  if (fmt === 'VP8X') return { fmt, w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) }
  if (fmt === 'VP8 ') return { fmt, w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff }
  if (fmt === 'VP8L') { const v = b.readUInt32LE(21); return { fmt, w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 } }
  return { fmt }
}
for (const p of process.argv.slice(2)) {
  const b = readFileSync(p)
  const dim = p.endsWith('.png') ? pngSize(b) : webpSize(b)
  console.log(p.split('\\').pop(), JSON.stringify(dim), Math.round(statSync(p).size / 1024) + 'KB', '比例=' + (dim.w && dim.h ? (dim.w / dim.h).toFixed(3) : '?'))
}
