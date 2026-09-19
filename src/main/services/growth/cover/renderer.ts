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

import { BrowserWindow, nativeImage } from 'electron'
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

/**
 * 按请求尺寸整页截图（不受窗口大小限制）。
 * 离屏窗口会被系统裁到工作区高度，竖版封面（1536 高）因此会被静默截断；
 * CDP 的 captureBeyondViewport 按 clip 直接取整页，是唯一稳妥的办法。
 * 用完立刻 detach：一个 webContents 只能挂一个调试器。
 */
async function captureBeyondViewport(
  win: BrowserWindow,
  width: number,
  height: number
): Promise<Buffer> {
  const dbg = win.webContents.debugger
  try {
    dbg.attach('1.3')
    const res = (await dbg.sendCommand('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 }
    })) as { data?: string }
    const data = String(res?.data ?? '')
    if (!data) throw new Error('CDP 未返回截图数据')
    return Buffer.from(data, 'base64')
  } finally {
    try {
      if (dbg.isAttached()) dbg.detach()
    } catch {
      /* 已断开 */
    }
  }
}

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

    /**
     * 窗口尺寸会被系统**裁到工作区**（本机 1440 高的屏 → 内容区最多 1392），
     * 而封面常是 1024×1536 这类竖版：直接用 capturePage 会**静默截掉底部** ——
     * 实测 1024×1536 只拿到 1024×1392，压在最下面的副标题/署名整行消失
     * （历史产出 asset 16 就是这样：库里写 1024×1536，文件实际 1392 高）。
     * 所以先看窗口实际内容区，够大才用 capturePage；不够就改用 CDP 的
     * captureBeyondViewport（按请求尺寸整页截取，不受窗口限制）。
     */
    const avail = win.getContentSize()
    const clipped = avail[0] < width || avail[1] < height
    let png: Buffer
    if (clipped) {
      log.info(
        'cover window clamped to ' +
          String(avail[0]) +
          'x' +
          String(avail[1]) +
          ' (< ' +
          String(width) +
          'x' +
          String(height) +
          ')，改用 CDP 整页截取'
      )
      png = await withTimeout(captureBeyondViewport(win, width, height), timeoutMs, '封面截图超时')
    } else {
      png = (await withTimeout(win.webContents.capturePage(), timeoutMs, '封面截图超时')).toPNG()
    }
    if (!png || png.length === 0) {
      // 离屏渲染偶发「第一帧还没上屏」，再给一次机会
      await sleep(250)
      png = clipped
        ? await withTimeout(captureBeyondViewport(win, width, height), timeoutMs, '封面截图超时')
        : (await withTimeout(win.webContents.capturePage(), timeoutMs, '封面截图超时')).toPNG()
    }
    if (!png || png.length === 0) throw new Error('封面渲染结果为空(离屏窗口未产出画面)')
    // 尺寸自检：输出尺寸必须等于请求尺寸，否则就是又被裁了（这次不留到用户手上才发现）
    const got = nativeImage.createFromBuffer(png).getSize()
    if (got.width !== width || got.height !== height) {
      log.warn(
        'cover size mismatch: want ' +
          String(width) +
          'x' +
          String(height) +
          ', got ' +
          String(got.width) +
          'x' +
          String(got.height)
      )
    }
    log.info(
      'cover rendered ' +
        String(width) +
        'x' +
        String(height) +
        ' (' +
        String(png.length) +
        ' bytes' +
        (clipped ? ', via CDP' : '') +
        ')'
    )
    return png
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}
