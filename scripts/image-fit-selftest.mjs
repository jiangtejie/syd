#!/usr/bin/env node
/**
 * 大图预览自适应几何的自检（纯函数，零依赖）：
 *   node --experimental-strip-types scripts/image-fit-selftest.mjs
 *
 * 为什么值得钉死：图片变形是一类「只是图丑了」的静默故障 —— 线上表现是横图被拉成
 * 本地占位 SVG 的 3:4（占位图 360×480 先量出尺寸，真图沿用了它，且此后再也没重测）。
 * 这里把两条不变量钉死：**显示宽高比 == 原图宽高比**、**自适应结果必须放得进弹层**。
 */
import {
  FIT_MAX,
  MAX_SCALE,
  MIN_SCALE,
  clampScale,
  displaySize,
  fitScale,
  keepsAspectRatio,
  normalizeNatural,
  previewViewport
} from '../src/renderer/src/lib/imageFit.ts'

let failed = 0
const log = (ok, name, detail) => {
  if (!ok) failed++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`)
}

const shapes = [
  ['横图', { w: 4032, h: 3024 }],
  ['竖图', { w: 3024, h: 4032 }],
  ['方图', { w: 1000, h: 1000 }],
  ['全景', { w: 6000, h: 800 }],
  ['细长截图', { w: 600, h: 4800 }],
  ['小缩略图', { w: 120, h: 90 }],
  ['1px', { w: 1, h: 1 }]
]

console.log('\n[1] 宽高比不变量：任何原图 × 任何缩放都不得变形')
for (const [name, nat] of shapes) {
  const bad = [0.05, 0.2, 1, 2.6, 5]
    .map((s) => displaySize(nat, s))
    .filter((d) => !keepsAspectRatio(nat, d))
  log(
    bad.length === 0,
    `${name} ${nat.w}×${nat.h} 任意缩放都不变形`,
    bad.length ? JSON.stringify(bad) : undefined
  )
}

console.log('\n[2] 复现线上那条故障：占位图的尺寸不能污染真图')
const placeholder = normalizeNatural(360, 480) // 本地占位 SVG 的固有尺寸
const real = normalizeNatural(4032, 3024) // 真·横图
const vp = previewViewport(1600, 900)
const stale = displaySize(placeholder, fitScale(placeholder, vp))
log(
  !keepsAspectRatio(real, stale),
  '旧写法（沿用占位图尺寸）确实会把横图拉成 3:4 —— 这就是被修掉的故障',
  `${stale.w}×${stale.h}`
)
const fresh = displaySize(real, fitScale(real, vp))
log(keepsAspectRatio(real, fresh), '新写法（换图重测尺寸）横图保持 4:3', `${fresh.w}×${fresh.h}`)

console.log('\n[3] 自适应必须放得进弹层（否则每张长图都顶出一条滚动条）')
log(vp.h <= 900 * 0.8 + 1, '可用高度不超过弹层给图片的 80vh', `${vp.h} ≤ 720`)
for (const [name, nat] of shapes) {
  const d = displaySize(nat, fitScale(nat, vp))
  log(
    d.w <= vp.w + 1 && d.h <= vp.h + 1,
    `${name} 自适应后 ≤ 可用区 ${vp.w}×${vp.h}`,
    `${d.w}×${d.h}`
  )
}

console.log('\n[4] 小图放大有上限、超大图不炸也不夹死')
log(fitScale({ w: 100, h: 80 }, vp) === FIT_MAX, `小图放大封顶 ${FIT_MAX}x`)
log(
  fitScale({ w: 20000, h: 20000 }, vp) < 0.1,
  '超大图缩到放得下（自适应不走 MIN_SCALE，否则反而放不下）',
  String(fitScale({ w: 20000, h: 20000 }, vp))
)
log(
  displaySize({ w: 20000, h: 20000 }, fitScale({ w: 20000, h: 20000 }, vp)).w <= vp.w,
  '超大图渲染尺寸不超窗'
)

console.log('\n[5] 脏输入兜底（浏览器在解码完成前会给 0）')
log(JSON.stringify(normalizeNatural(0, 0)) === '{"w":800,"h":600}', '0×0 → 兜底 800×600')
log(
  keepsAspectRatio({ w: 800, h: 600 }, normalizeNatural(0, 600)),
  '只有高有效时按兜底比例补宽（不引入新的形变）'
)
const zero = displaySize({ w: 0, h: 0 }, 0)
log(
  Number.isFinite(zero.w) && Number.isFinite(zero.h) && zero.w > 0 && zero.h > 0,
  '零尺寸 + 零缩放不产生 NaN/0',
  JSON.stringify(zero)
)
log(clampScale(999) === MAX_SCALE && clampScale(0.0001) === MIN_SCALE, '手动缩放夹在 [MIN, MAX]')
log(clampScale(Number.NaN) === 1, 'NaN 缩放回落 1')
log(
  Number.isFinite(previewViewport(0, 0).w) && previewViewport(0, 0).w >= 160,
  '窗口尺寸为 0 时不产生 0 宽画布'
)

if (failed > 0) {
  console.error(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
