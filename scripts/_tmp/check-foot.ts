/** 底部区域到底有没有内容：逐行统计（原来 2% 一跳会跳过一行文字，结论不可信） */
import { app, nativeImage } from 'electron'

app.whenReady().then(() => {
  const img = nativeImage.createFromPath(process.argv[2])
  const size = img.getSize()
  const bmp = img.toBitmap()
  const rowNonWhite = (y) => {
    let n = 0
    for (let x = 0; x < size.width; x += 2) {
      const i = (y * size.width + x) * 4
      if (bmp[i] < 245 || bmp[i + 1] < 245 || bmp[i + 2] < 245) n++
    }
    return n
  }
  let total = 0
  let best = { y: 0, n: 0 }
  for (let y = Math.round(size.height * 0.88); y < size.height; y += 1) {
    const n = rowNonWhite(y)
    total += n
    if (n > best.n) best = { y, n }
  }
  console.log('画布:', size.width + 'x' + size.height)
  console.log('底部 12% 的非白像素总数 =', total)
  console.log('内容最多的一行: y=' + String(best.y) + '（距底 ' + String(Math.round(((size.height - best.y) / size.height) * 100)) + '%）非白像素 =', best.n)
  app.quit()
})
