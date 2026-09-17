/**
 * 打包前自检：**宁可现在失败，也别产出一个装上去才发现坏了的包**。
 *
 * 检查三类真实的坏包来源：
 *  ① 新克隆的仓库忘了跑 ffmpeg:prepare → extraResources 找不到源目录 / 目标机没有 ffmpeg
 *     （表现为"图还是糊的"，事后很难查）；
 *  ② 注入脚本（resources/ps/*.ps1）缺失 → 发送功能在打包后静默失效；
 *  ③ **原生模块在 Electron 里加载不了** → 一读库就崩。这一条不做静态猜测，直接让 Electron
 *     本体加载一次（ELECTRON_RUN_AS_NODE），这是最接近真机的判据。
 *
 * 关于原生模块为什么要这么查：better-sqlite3-multiple-ciphers 13 是 **N-API 预编译包**
 * （prebuilds/<平台>-<架构>.node，node-gyp-build 约定，gypfile:false）。N-API 跨 Node 与
 * Electron 版本 ABI 稳定，所以**不需要 rebuild**（npmRebuild: false 是刻意的）。
 * 会出事的不是"ABI 不对"，而是：依赖没装、目标架构的 prebuild 缺失、或打包时把 prebuilds 剪错。
 * 所以静态检查 build/Release/*.node 那种老式判据是错的（本文件第一版就写错了）。
 *
 * 检查不通过就 exit 1，并给出**可执行的修复命令**。
 */
import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const notes = []
const isWin = process.platform === 'win32'
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// ── 1) 随包资源 ──
const binName = isWin ? 'ffmpeg.exe' : 'ffmpeg'
const ffmpeg = join(root, 'resources', 'bin', binName)
if (!existsSync(ffmpeg)) {
  problems.push(
    '随包 ffmpeg 缺失：' + ffmpeg + '\n     修复：npm run ffmpeg:prepare -- "<ffmpeg.exe 路径>"'
  )
} else {
  const mb = (readFileSync(ffmpeg).length / 1024 / 1024).toFixed(1)
  notes.push('随包 ffmpeg ' + mb + ' MB')
}

const psFiles = ['wechat-inject.ps1', 'wechat-ocr.ps1', 'wechat-window.ps1']
const missingPs = psFiles.filter((f) => !existsSync(join(root, 'resources', 'ps', f)))
if (missingPs.length > 0) problems.push('注入脚本缺失：resources/ps/' + missingPs.join(', '))
else notes.push('注入脚本 ' + psFiles.length + ' 个就位')

// ── 2) Electron 本体 ──
const electronExe = join(root, 'node_modules', 'electron', 'dist', isWin ? 'electron.exe' : 'electron')
if (!existsSync(electronExe)) {
  problems.push('本地 Electron 运行时缺失（node_modules/electron/dist）→ 离线打包会失败；修复：npm install')
} else {
  try {
    const ev = JSON.parse(readFileSync(join(root, 'node_modules', 'electron', 'package.json'), 'utf8'))
    notes.push('electron ' + ev.version + '（package.json 声明 ' + String(pkg.devDependencies?.electron ?? '') + '）')
  } catch {
    notes.push('electron 运行时就位')
  }
}

// ── 3) 原生模块：让 Electron 真的加载一次 ──
const modDir = join(root, 'node_modules', 'better-sqlite3-multiple-ciphers')
if (!existsSync(modDir)) {
  problems.push('依赖未安装：node_modules/better-sqlite3-multiple-ciphers 不存在；修复：npm install')
} else {
  // 先看目标架构的 prebuild 在不在（给出比"加载失败"更精确的提示）
  const arch = process.arch
  const prebuild = join(modDir, 'prebuilds', process.platform + '-' + arch + '.node')
  if (!existsSync(prebuild)) {
    problems.push(
      '缺少本平台预编译二进制：prebuilds/' + process.platform + '-' + arch + '.node\n' +
        '     修复：npm install（该包按平台发预编译包，装完就有了）'
    )
  }
  if (existsSync(electronExe)) {
    const probe =
      "const D=require('better-sqlite3-multiple-ciphers');" +
      "const d=new D(':memory:');d.exec('create table t(a)');" +
      "d.prepare('insert into t values (1)').run();" +
      "process.stdout.write('rows=' + d.prepare('select count(*) c from t').get().c);d.close()"
    try {
      const out = execFileSync(electronExe, ['-e', probe], {
        cwd: root,
        encoding: 'utf8',
        timeout: 60000,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      })
      notes.push('原生模块在 Electron 里实测可用（' + String(out).trim() + '）')
    } catch (e) {
      const detail = (e && typeof e === 'object' && 'stderr' in e ? String(e.stderr) : '') || (e instanceof Error ? e.message : String(e))
      problems.push('原生模块在 Electron 里加载失败 —— 打出来的包一读库就会崩：\n     ' + detail.slice(0, 300).trim())
    }
  }
}

console.log('打包前自检：')
for (const n of notes) console.log('  ✔ ' + n)
if (problems.length > 0) {
  console.error('\n✖ 有 ' + problems.length + ' 项没准备好：')
  for (const p of problems) console.error('  - ' + p)
  process.exit(1)
}
console.log('\n可以打包了。')
