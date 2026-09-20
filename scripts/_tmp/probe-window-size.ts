/** 查清 renderHtmlToPng 的实际内容区尺寸：离屏窗口是不是被系统裁短了 */
import { app, BrowserWindow } from 'electron'

app.whenReady().then(async () => {
  const want = { w: 1024, h: 1536 }
  const win = new BrowserWindow({
    show: false,
    width: want.w,
    height: want.h,
    useContentSize: true,
    webPreferences: { offscreen: true, javascript: false }
  })
  console.log('getContentSize =', JSON.stringify(win.getContentSize()), 'want =', JSON.stringify([want.w, want.h]))
  console.log('getBounds      =', JSON.stringify(win.getBounds()))
  const shot = await win.webContents.capturePage()
  console.log('capturePage    =', JSON.stringify(shot.getSize()))
  win.destroy()

  const win2 = new BrowserWindow({
    show: false,
    width: want.w,
    height: want.h,
    useContentSize: true,
    enableLargerThanScreen: true,
    webPreferences: { offscreen: true, javascript: false }
  })
  console.log('enableLargerThanScreen → getContentSize =', JSON.stringify(win2.getContentSize()))
  const shot2 = await win2.webContents.capturePage()
  console.log('enableLargerThanScreen → capturePage =', JSON.stringify(shot2.getSize()))
  win2.destroy()
  app.quit()
})
