/** 渲染一张「清单榜单」封面样例（验证新模板真的排得下、中文正常、序号自增） */
import { app } from 'electron'
import { writeFileSync, mkdirSync } from 'node:fs'
import { buildCoverHtml } from '../../src/main/services/growth/cover/templates'
import { renderHtmlToPng } from '../../src/main/services/growth/cover/renderer'

app.whenReady().then(async () => {
  const doc = buildCoverHtml({
    templateId: 'list',
    title: '国庆来重庆，观音桥这家老重庆牛油锅别错过',
    subtitle: '甜品免费 · 人均98',
    badge: '观音桥',
    items: [
      '老重庆牛油锅底 · 招牌九宫格',
      '麻辣鸡爪 · 现卤现拌',
      '精品牛肚 · 七上八下',
      '鲜切黄牛肉 · 8 秒出锅',
      '甜品免费 · 冰粉凉虾随便吃',
      '人均 98 · 观音桥步行街 3 分钟',
      '营业时间 17:00-23:00',
      '电话 15736502951'
    ],
    footNote: '眼镜火锅 · 整理',
    width: 1024,
    height: 1536
  })
  const png = await renderHtmlToPng(doc.html, { width: 1024, height: 1536 })
  const out = process.argv[2]
  mkdirSync(out.substring(0, out.lastIndexOf('\\')), { recursive: true })
  writeFileSync(out, png)
  console.log('rendered', out, Math.round(png.length / 1024) + 'KB', 'items=' + String(doc.itemLines.length))
  app.quit()
})
