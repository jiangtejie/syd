/**
 * 封面渲染尺寸自检（需要 electron：离屏窗口 + 截图）。
 *
 * 钉住的是一条**静默截断**：BrowserWindow 的内容区会被系统裁到工作区高度
 * （本机 1440 屏 → 最多 1392），而封面常是 1024×1536 —— 直接用 capturePage
 * 会悄悄把底部 9% 切掉（副标题/署名整行消失，库里还写着 1024×1536）。
 * 实测历史产出 asset 16 就是这样：库记录 1024×1536，文件实际 1024×1392。
 *
 * 跑法（不进 test:all：它需要 electron 运行时）：
 *   npx electron scripts/cover-render-size-selftest.mjs
 */
import { app, nativeImage } from 'electron'
import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'dsh-cover-size-'))
let failed = 0
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  ✔ ' : '  ✖ ') + label + (extra ? ' — ' + extra : ''))
  if (!cond) failed++
}

/**
 * 关键：离屏窗口销毁后 Electron 默认会「没有窗口就退出」（Windows 上尤其明显），
 * 于是第一张渲染完之后进程直接结束、后面的断言根本跑不到（实测：只打印两条就 exit 0）。
 * 自检脚本要自己按住这个默认行为。
 */
app.on('window-all-closed', () => {
  /* 自检脚本：窗口关完了也继续跑断言 */
})

app.whenReady().then(async () => {
  try {
    // 产物落在临时目录：external 的原生模块要从仓库 node_modules 解析，所以写进产物目录再 require
    const bundle = resolve(root, 'scripts', '_cover-render-size.cjs')
    buildSync({
      entryPoints: [join(root, 'src/main/services/growth/cover/renderer.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: bundle,
      external: ['electron', 'better-sqlite3-multiple-ciphers']
    })
    const { buildCoverHtml } = require(
      (() => {
        const p = resolve(root, 'scripts', '_cover-templates.cjs')
        buildSync({
          entryPoints: [join(root, 'src/main/services/growth/cover/templates.ts')],
          bundle: true,
          platform: 'node',
          format: 'cjs',
          outfile: p
        })
        return p
      })()
    )
    const { renderHtmlToPng } = require(bundle)

    const doc = buildCoverHtml({
      templateId: 'list',
      title: '国庆来重庆，观音桥这家老重庆牛油锅别错过',
      subtitle: '甜品免费 · 人均98',
      badge: '观音桥',
      items: ['第一项', '第二项', '第三项'],
      footNote: '眼镜火锅 · 整理',
      width: 1024,
      height: 1536
    })
    const png = await renderHtmlToPng(doc.html, { width: 1024, height: 1536 })
    const size = nativeImage.createFromBuffer(png).getSize()

    console.log('渲染尺寸自检（竖版 1024×1536，高于本机工作区 1392）：')
    ok(size.width === 1024 && size.height === 1536, '★ 输出尺寸等于请求尺寸（不再被工作区裁短）', size.width + 'x' + size.height)

    const bmp = nativeImage.createFromBuffer(png).toBitmap()
    let bottomInk = 0
    for (let y = Math.round(size.height * 0.93); y < size.height; y += 1) {
      for (let x = 0; x < size.width; x += 2) {
        const i = (y * size.width + x) * 4
        if (bmp[i] < 245 || bmp[i + 1] < 245 || bmp[i + 2] < 245) bottomInk++
      }
    }
    ok(bottomInk > 0, '★ 底部 7% 有内容（署名/分隔线没被切掉）', String(bottomInk) + ' 像素')

    // 小尺寸（低于工作区）走的是 capturePage 老路径，也要正常。
    // 连续两次离屏渲染之间要留一点间隔：上一张窗口刚销毁就开下一张，
    // data: URL 偶发 ERR_FAILED(-2)（截断说明是时序问题，不是渲染问题）
    await new Promise((r) => setTimeout(r, 400))
    const small = buildCoverHtml({ templateId: 'bold-bottom', title: '测试标题', width: 1024, height: 1024 })
    const smallPng = await renderHtmlToPng(small.html, { width: 1024, height: 1024 })
    const smallSize = nativeImage.createFromBuffer(smallPng).getSize()
    ok(smallSize.width === 1024 && smallSize.height === 1024, '方图（低于工作区）走原路径也正常', smallSize.width + 'x' + smallSize.height)
  } catch (e) {
    ok(false, '渲染抛错', e instanceof Error ? e.message : String(e))
  } finally {
    // 打包产物是临时文件（scripts/_*.cjs，跑完即删）
    for (const p of [join(root, 'scripts', '_cover-render-size.cjs'), join(root, 'scripts', '_cover-templates.cjs')]) {
      try {
        rmSync(p, { force: true })
      } catch {
        /* ignore */
      }
    }
    try {
      rmSync(work, { recursive: true, force: true })
    } catch {
      /* Windows 偶发占用 */
    }
    console.log(failed === 0 ? '\n全部通过 ✅' : '\n' + String(failed) + ' 项失败 ❌')
    app.exit(failed === 0 ? 0 : 1)
  }
})
