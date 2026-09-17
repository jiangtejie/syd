/**
 * 构建后写一份"这个包是什么"的记录（dist/BUILD-INFO.txt）。
 *
 * 为什么需要：门店/客户报问题时，第一个要问的就是"你装的是哪一版"。安装包文件名里只有版本号，
 * 没有 commit、没有校验值 —— 而这三样正好是判断"是不是同一个包"的全部依据。
 *
 * 顺带把随包 ffmpeg 的校验值也写进去：它不在版本库里，是构建时放进去的，
 * 不记下来事后无法确认某台机器上跑的那份是不是同一个二进制。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

function sha256(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch {
    return '(读不到)'
  }
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    return '(非 git 仓库或 git 不可用)'
  }
}

const installers = existsSync(dist)
  ? readdirSync(dist).filter((f) => f.endsWith('.exe') && !f.includes('uninstaller'))
  : []

const ffmpegName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
const ffmpegPath = join(root, 'resources', 'bin', ffmpegName)

const lines = []
lines.push('构建信息 · ' + pkg.name + ' v' + pkg.version)
lines.push('='.repeat(60))
lines.push('构建时间     : ' + new Date().toISOString())
lines.push('git commit   : ' + git(['rev-parse', '--short', 'HEAD']) + ' (' + git(['rev-parse', '--abbrev-ref', 'HEAD']) + ')')
lines.push('工作区状态   : ' + (git(['status', '--porcelain']) ? '有未提交改动' : '干净'))
lines.push('node / 平台  : ' + process.version + ' / ' + process.platform + '-' + process.arch)
lines.push('')
lines.push('产物：')
if (installers.length === 0) {
  lines.push('  (dist 下没有找到安装包 —— 先跑 npm run build:win 或 build:win:offline)')
} else {
  for (const f of installers) {
    const p = join(dist, f)
    lines.push('  ' + f)
    lines.push('    大小      : ' + (statSync(p).size / 1024 / 1024).toFixed(1) + ' MB (' + statSync(p).size + ' 字节)')
    lines.push('    SHA256    : ' + sha256(p))
  }
}
lines.push('')
lines.push('随包 ffmpeg：')
if (existsSync(ffmpegPath)) {
  lines.push('  ' + ffmpegName + ' · ' + (statSync(ffmpegPath).size / 1024 / 1024).toFixed(1) + ' MB')
  lines.push('  SHA256    : ' + sha256(ffmpegPath))
  lines.push('  （不在版本库；重新获取见 scripts/prepare-ffmpeg.mjs 与 docs/ffmpeg-bundling.md）')
} else {
  lines.push('  (无 —— 未跑 ffmpeg:prepare，目标机需自行配置 ffmpeg 路径)')
}
lines.push('')
lines.push('安装说明：本安装包**未做代码签名**，Windows SmartScreen 会提示"未知发布者"，')
lines.push('         需点「更多信息 → 仍要运行」。')
lines.push('')

const out = join(dist, 'BUILD-INFO.txt')
if (!existsSync(dist)) {
  console.error('dist 不存在，先打包：npm run build:win')
  process.exit(1)
}
writeFileSync(out, lines.join('\n'), 'utf8')
console.log('已写入 ' + out)
console.log(lines.slice(0, 8).join('\n'))
