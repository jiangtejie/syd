/**
 * 把一份 ffmpeg 放进随包目录（resources/bin），并记录版本与校验值。
 *
 * 用法：
 *   node scripts/prepare-ffmpeg.mjs "D:\\ffmpeg-9.0.1\\bin\\ffmpeg.exe"
 *   node scripts/prepare-ffmpeg.mjs            # 读环境变量 FFMPEG_SRC
 *
 * 为什么要脚本而不是直接拷：随包发的是**可执行文件**，得能说清它是哪一份、校验值是多少。
 * 换二进制（例如以后换成体积更小的 LGPL 最小构建）只需重跑这条命令，代码不用动。
 *
 * 注意：它只拷 ffmpeg 本体，不拷 ffplay/ffprobe —— 这套参数只需要
 * hevc 解码 + mjpeg 编码 + hevc 解复用（见 datDecrypt.convertHevcToJpeg 的命令行）。
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const destDir = join(root, 'resources', 'bin')
const isWin = process.platform === 'win32'
const binName = isWin ? 'ffmpeg.exe' : 'ffmpeg'

const src = (process.argv[2] ?? process.env.FFMPEG_SRC ?? '').trim()

if (!src) {
  console.error('缺少源文件路径。用法：node scripts/prepare-ffmpeg.mjs "<path to ffmpeg.exe>"')
  console.error('也可以设环境变量 FFMPEG_SRC。')
  process.exit(1)
}
if (!existsSync(src) || !statSync(src).isFile()) {
  console.error('找不到文件：' + src)
  process.exit(1)
}

let versionLine = '(未能读取版本)'
let configLine = ''
try {
  const out = execFileSync(src, ['-version'], { encoding: 'utf8', timeout: 20000 })
  const lines = String(out).split(/\r?\n/)
  versionLine = (lines[0] ?? '').trim() || versionLine
  configLine = (lines.find((l) => l.startsWith('configuration:')) ?? '').trim()
} catch (e) {
  console.error('执行 ' + src + ' -version 失败：' + (e instanceof Error ? e.message : String(e)))
  process.exit(1)
}

const sizeMb = statSync(src).size / 1024 / 1024
const sha256 = createHash('sha256').update(readFileSync(src)).digest('hex')

// 能力自检：这套参数只用到三样，缺一样就白搭
let missing = []
try {
  const dec = execFileSync(src, ['-hide_banner', '-decoders'], { encoding: 'utf8', timeout: 20000 })
  const enc = execFileSync(src, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 20000 })
  const dem = execFileSync(src, ['-hide_banner', '-demuxers'], { encoding: 'utf8', timeout: 20000 })
  if (!/^\s*V\S*\s+hevc\s/m.test(dec)) missing.push('hevc 解码器')
  if (!/^\s*V\S*\s+mjpeg\s/m.test(enc)) missing.push('mjpeg 编码器')
  if (!/^\s*D\s+hevc\s/m.test(dem)) missing.push('hevc 解复用')
} catch {
  missing.push('能力探测失败')
}

mkdirSync(destDir, { recursive: true })
const dest = join(destDir, binName)
copyFileSync(src, dest)

const isGpl = /--enable-gpl/.test(configLine)
const notice = [
  '# 随包 ffmpeg',
  '',
  '本目录的 ffmpeg 由 scripts/prepare-ffmpeg.mjs 放入，用于解码微信 wxgf(HEVC) 图片首帧。',
  '**不进版本库**（见 .gitignore）；重新获取二进制的步骤见该脚本头部注释。',
  '',
  '| 项 | 值 |',
  '| --- | --- |',
  '| 文件名 | ' + binName + ' |',
  '| 版本 | ' + versionLine.replace(/\|/g, '\\|') + ' |',
  '| 体积 | ' + sizeMb.toFixed(1) + ' MB |',
  '| SHA256 | ' + sha256 + ' |',
  '| 来源 | ' + src + ' |',
  '| 放入时间 | ' + new Date().toISOString() + ' |',
  '',
  '## 许可证',
  '',
  isGpl
    ? '⚠️ 这是一份 **GPL 构建**（configuration 里带 --enable-gpl）。以独立进程方式随包分发时，' +
      'GPL 义务落在**这个二进制本身**：对外分发安装包时需要随附许可证文本与对应源码的获取方式。' +
      '若不想承担该义务，换一份 **LGPL 最小构建**（只需 hevc 解码 + mjpeg 编码，约 10-20MB）' +
      '重跑本脚本即可，应用代码无需改动。'
    : '这是一份 **非 GPL（LGPL 系）构建**，随包分发时按 LGPL 履行义务（附许可证文本与源码获取方式）。',
  '',
  '> 另注：HEVC 除版权还有**专利**许可问题（Access Advance / Via LA 等专利池），',
  '> 与 ffmpeg 的许可证是两件事，商用分发前请自行确认。',
  ''
].join('\n')
writeFileSync(join(destDir, 'NOTICE.md'), notice, 'utf8')

console.log('已放入：' + dest)
console.log('  ' + versionLine)
console.log('  体积 ' + sizeMb.toFixed(1) + ' MB · sha256 ' + sha256.slice(0, 16) + '…')
if (missing.length > 0) {
  console.error('✖ 能力缺失：' + missing.join('、') + ' —— 这份二进制解不了 wxgf 图片')
  process.exitCode = 1
} else {
  console.log('  ✔ 能力齐全：hevc 解码 / mjpeg 编码 / hevc 解复用')
}
if (isGpl) {
  console.log('  ⚠️ 该构建为 GPL（--enable-gpl）：对外分发前请确认许可证义务，或改用 LGPL 最小构建')
}
if (sizeMb > 60) {
  console.log('  ⚠️ 体积偏大：这份是全功能构建，会让安装包明显变大（最小构建约 10-20MB）')
}
console.log('  已写 resources/bin/NOTICE.md（版本/校验值/许可证）')
