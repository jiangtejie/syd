/** 端到端复验：修复后的 renderHtmlToPng 是否还裁底 */
import { app, nativeImage } from 'electron'
import { writeFileSync } from 'node:fs'
import { buildCoverHtml } from '../../src/main/services/growth/cover/templates'
import { renderHtmlToPng } from '../../src/main/services/growth/cover/renderer'

app.whenReady().then(async () => {
  const doc = buildCoverHtml({
    templateId: 'list',
    title: '国庆来重庆，观音桥这家老重庆牛油锅别错过',
    subtitle: '甜品免费 · 人均98',
    badge: '观音桥',
    items: ['老重庆牛油锅底 · 招牌九宫格', '麻辣鸡爪 · 现卤现拌', '精品牛肚 · 七上八下', '鲜切黄牛肉 · 8 秒出锅', '甜品免费 · 冰粉凉虾随便吃', '人均 98 · 观音桥步行街 3 分钟', '营业时间 17:00-23:00', '电话 15736502951'],
    footNote: '眼镜火锅 · 整理',
    width: 1024,
    height: 1536
  })
  const png = await renderHtmlToPng(doc.html, { width: 1024, height: 1536 })
  const out = process.argv[2]
  writeFileSync(out, png)
  const img = nativeImage.createFromBuffer(png)
  const size = img.getSize()
  console.log('输出尺寸 =', JSON.stringify(size), '期望 1024x1536', size.height === 1536 ? '✓' : '✗ 仍被裁')
  const bmp = img.toBitmap()
  let bottom = 0
  for (let y = Math.round(size.height * 0.93); y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 2) {
      const i = (y * size.width + x) * 4
      if (bmp[i] < 245 || bmp[i + 1] < 245 || bmp[i + 2] < 245) bottom++
    }
  }
  console.log('底部 7% 非白像素 =', bottom, bottom > 0 ? '✓ 署名/边线在画面里' : '✗ 底部仍空')
  app.quit()
})
