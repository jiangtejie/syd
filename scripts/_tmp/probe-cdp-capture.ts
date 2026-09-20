/** 离屏窗口被工作区裁到 1392 高：试 CDP 的 captureBeyondViewport 能不能拿到完整的 1536 */
import { app, BrowserWindow, nativeImage } from 'electron'
import { buildCoverHtml } from '../../src/main/services/growth/cover/templates'

app.whenReady().then(async () => {
  const W = 1024
  const H = 1536
  const doc = buildCoverHtml({
    templateId: 'list',
    title: '国庆来重庆，观音桥这家老重庆牛油锅别错过',
    subtitle: '甜品免费 · 人均98',
    badge: '观音桥',
    items: ['老重庆牛油锅底 · 招牌九宫格', '麻辣鸡爪 · 现卤现拌', '精品牛肚 · 七上八下', '鲜切黄牛肉 · 8 秒出锅'],
    footNote: '眼镜火锅 · 整理',
    width: W,
    height: H
  })
  const win = new BrowserWindow({
    show: false,
    width: W,
    height: H,
    useContentSize: true,
    webPreferences: { offscreen: true, javascript: false, contextIsolation: true, sandbox: true }
  })
  const avail = win.getContentSize()
  console.log('窗口内容区（系统裁过的）=', JSON.stringify(avail), ' 目标 =', JSON.stringify([W, H]))
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(doc.html))
  await new Promise((r) => win.webContents.once('paint', () => r(null)))
  await new Promise((r) => setTimeout(r, 400))

  const plain = (await win.webContents.capturePage()).toPNG()
  console.log('capturePage 尺寸 =', JSON.stringify(nativeImage.createFromBuffer(plain).getSize()))

  const dbg = win.webContents.debugger
  try {
    dbg.attach('1.3')
    const res = await dbg.sendCommand('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: W, height: H, scale: 1 }
    })
    const buf = Buffer.from(res.data, 'base64')
    const img = nativeImage.createFromBuffer(buf)
    console.log('CDP clip 尺寸 =', JSON.stringify(img.getSize()), Math.round(buf.length / 1024) + 'KB')
    // 底部 8% 有没有内容（署名行应该在那里）
    const size = img.getSize()
    const bmp = img.toBitmap()
    let n = 0
    for (let y = Math.round(size.height * 0.92); y < size.height; y += 1) {
      for (let x = 0; x < size.width; x += 2) {
        const i = (y * size.width + x) * 4
        if (bmp[i] < 245 || bmp[i + 1] < 245 || bmp[i + 2] < 245) n++
      }
    }
    console.log('CDP 结果底部 8% 非白像素 =', n, '（>0 说明署名/边线在画面里）')
  } catch (e) {
    console.log('CDP 失败:', String(e))
  } finally {
    try { dbg.detach() } catch { /* ignore */ }
  }
  win.destroy()
  app.quit()
})
