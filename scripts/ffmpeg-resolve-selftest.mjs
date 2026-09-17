import { buildSync } from 'esbuild'
import { createRequire } from 'module'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

/**
 * ffmpeg 路径优先级自检（纯函数）。
 *
 * 钉住的事故形态：随包 ffmpeg 的优先级放错位置就会出问题 ——
 *  ① 若「随包」压过用户显式配置，用户想指定自己那份更新的 ffmpeg 就会失效；
 *  ② 若「随包」排在 PATH 之后，目标机 PATH 上恰好有个残缺/旧版 ffmpeg 时会先命中它，
 *     表现为「装了包还是解不出 HEVC 图」这种很难查的现象；
 *  ③ 显式配置即使文件不存在也必须原样返回，让人当场发现填错路径。
 */

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'dsh-ffmpeg-'))

let failed = 0
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  ✔ ' : '  ✖ ') + label + (extra ? ' — ' + extra : ''))
  if (!cond) failed++
}

try {
  const bundle = join(work, 'ffmpegPath.cjs')
  buildSync({
    entryPoints: [join(root, 'src/main/services/media/ffmpegPath.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: bundle
  })
  const { pickFfmpegPath, FFMPEG_FALLBACK } = require(bundle)

  const input = (over) =>
    Object.assign(
      { configured: '', configuredExists: false, envPath: '', envExists: false, bundled: '', bundledExists: false },
      over
    )

  console.log('优先级：')
  ok(
    pickFfmpegPath(input({ configured: 'C:/my/ffmpeg.exe', envPath: 'C:/env/ffmpeg.exe', envExists: true, bundled: 'C:/app/bin/ffmpeg.exe', bundledExists: true })) ===
      'C:/my/ffmpeg.exe',
    '显式配置压过环境变量与随包'
  )
  ok(
    pickFfmpegPath(input({ envPath: 'C:/env/ffmpeg.exe', envExists: true, bundled: 'C:/app/bin/ffmpeg.exe', bundledExists: true })) ===
      'C:/env/ffmpeg.exe',
    '没配置时环境变量优先'
  )
  ok(
    pickFfmpegPath(input({ bundled: 'C:/app/bin/ffmpeg.exe', bundledExists: true })) ===
      'C:/app/bin/ffmpeg.exe',
    '★ 随包命中（装了包就能用，目标机不用手填路径）'
  )
  ok(pickFfmpegPath(input()) === FFMPEG_FALLBACK, '★ 什么都没有才退回 PATH 上的 ffmpeg', FFMPEG_FALLBACK)

  console.log('不该被静默跳过/替换的情形：')
  ok(
    pickFfmpegPath(input({ configured: 'C:/typo/ffmpeg.exe', configuredExists: false, bundled: 'C:/app/bin/ffmpeg.exe', bundledExists: true })) ===
      'C:/typo/ffmpeg.exe',
    '★ 显式配置写错也原样返回（让人当场发现，而不是偷偷换成随包的）'
  )
  ok(
    pickFfmpegPath(input({ envPath: 'C:/env/missing.exe', envExists: false, bundled: 'C:/app/bin/ffmpeg.exe', bundledExists: true })) ===
      'C:/app/bin/ffmpeg.exe',
    '环境变量指向不存在的文件 → 落到随包'
  )
  ok(
    pickFfmpegPath(input({ envPath: 'C:/env/missing.exe', envExists: false })) === FFMPEG_FALLBACK,
    '环境变量失效且无随包 → 退回 PATH'
  )
  ok(
    pickFfmpegPath(input({ bundled: 'C:/app/bin/ffmpeg.exe', bundledExists: false })) === FFMPEG_FALLBACK,
    '随包文件不存在 → 退回 PATH（不返回一个死路径）'
  )

  console.log('空白与缺字段：')
  ok(pickFfmpegPath(input({ configured: '   ' })) === FFMPEG_FALLBACK, '全空白的配置视为未配置')
  ok(
    pickFfmpegPath(input({ configured: '  C:/a.exe  ' })) === 'C:/a.exe',
    '配置两侧空白被去掉（否则会 spawn 失败）'
  )
  ok(
    pickFfmpegPath(input({ bundled: '  C:/app/bin/ffmpeg.exe  ', bundledExists: true })) === 'C:/app/bin/ffmpeg.exe',
    '随包路径两侧空白被去掉'
  )
  ok(pickFfmpegPath({}) === FFMPEG_FALLBACK, '入参缺字段不炸')
} finally {
  try { rmSync(work, { recursive: true, force: true }) } catch { /* Windows 偶发占用 */ }
}

console.log(failed === 0 ? '\n全部通过 ✅' : '\n' + failed + ' 项失败 ❌')
process.exit(failed === 0 ? 0 : 1)
