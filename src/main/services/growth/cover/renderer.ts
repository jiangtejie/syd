/**
 * 封面渲染：把 templates.ts 产出的自包含 HTML 用 **Electron 离屏窗口**画出来并截成 PNG。
 *
 * 为什么用离屏窗口而不是图像库：
 *  - 不引原生依赖（sharp/canvas 都要跟着 Electron 重编译，装机与升级成本都高）；
 *  - 排版直接用 CSS（渐变、圆角、字重），要加新模板只改 CSS 字符串；
 *  - 中文字体用系统字体，不需要随包带字体文件。
 *
 * 风险与对策：离屏渲染是异步的，页面没画完就截图会得到空图 —— 所以
 *  ① 等首次 paint（带超时兜底）再截图；② 空图时重试一次；③ 仍然为空就明确报错，
 *  绝不返回一张空白封面当成功。
 */

import { BrowserWindow } from 'electron'
import { createLogger } from '../../logging'

const log = createLogger('growth-cover')

export interface CoverRenderOptions {
  width: number
  height: number
  /** 单个阶段（加载/截图）的超时，默认 15s */
  timeoutMs?: number
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 把 HTML 渲染成 PNG（离屏，不弹窗，不执行页面里的脚本） */
export async function renderHtmlToPng(html: string, opts: CoverRenderOptions): Promise<Buffer> {
  const width = Math.max(64, Math.round(opts.width))
  const height = Math.max(64, Math.round(opts.height))
  const timeoutMs = opts.timeoutMs ?? 15_000
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    webPreferences: {
      offscreen: true,
      // 页面是纯静态的：不跑脚本，减少攻击面（标题文本也已在 templates 里转义）
      javascript: false,
      contextIsolation: true,
      sandbox: true
    }
  })
  try {
    await withTimeout(
      win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)),
      timeoutMs,
      '封面页面加载超时'
    )
    // 等首次 paint：底图（data URI）解码与系统字体选中都要一点时间
    await Promise.race([
      new Promise<void>((resolve) => win.webContents.once('paint', () => resolve())),
      sleep(1200)
    ])
    await sleep(120)

    let png = (await withTimeout(win.webContents.capturePage(), timeoutMs, '封面截图超时')).toPNG()
    if (!png || png.length === 0) {
      // 离屏渲染偶发「第一帧还没上屏」，再给一次机会
      await sleep(250)
      png = (await withTimeout(win.webContents.capturePage(), timeoutMs, '封面截图超时')).toPNG()
    }
    if (!png || png.length === 0) throw new Error('封面渲染结果为空(离屏窗口未产出画面)')
    log.info(
      'cover rendered ' +
        String(width) +
        'x' +
        String(height) +
        ' (' +
        String(png.length) +
        ' bytes)'
    )
    return png
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}
