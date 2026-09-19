import { buildSync } from 'esbuild'
import { createRequire } from 'module'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

/**
 * 封面模板自检（纯函数，不碰库、不碰文件系统、不渲染）。
 *
 * 钉住三件「错了只是图难看、没有任何报错」的事：
 *  ① 标题必须折行且不超上限（不折行会溢出画面，超上限会盖住主体）；
 *  ② 标题里的尖括号/引号必须转义（用户标题里带 < 不能把 HTML 结构冲掉）；
 *  ③ 整份 HTML 必须自包含（只有 data: URI，没有外链）—— 离屏渲染是离线的。
 */

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'dsh-growth-cover-'))

let failed = 0
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  ✔ ' : '  ✖ ') + label + (extra ? ' — ' + extra : ''))
  if (!cond) failed++
}

try {
  const bundle = join(work, 'templates.cjs')
  buildSync({
    entryPoints: [join(root, 'src/main/services/growth/cover/templates.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle
  })
  const {
    COVER_TEMPLATES,
    DEFAULT_COVER_TEMPLATE,
    findCoverTemplate,
    titleFontSizeVw,
    maxCharsPerLine,
    wrapTitle,
    escapeHtml,
    buildCoverHtml
  } = require(bundle)

  console.log('模板清单：')
  ok(COVER_TEMPLATES.length >= 3, '至少 3 套模板可选', String(COVER_TEMPLATES.length))
  ok(
    COVER_TEMPLATES.every(
      (t) => t.id && t.label && t.when.length >= 6 && t.css.includes('.cover-title')
    ),
    '每套都有 id/名称/适用场景，且都定义了标题排版'
  )
  ok(
    COVER_TEMPLATES.some((t) => t.id === DEFAULT_COVER_TEMPLATE),
    '默认模板在清单里（否则回落会拿到 undefined）'
  )
  ok(findCoverTemplate('不存在').id === DEFAULT_COVER_TEMPLATE, '未知模板 → 回落默认')
  ok(findCoverTemplate('TOP-BAND').id === 'top-band', '模板 id 大小写不敏感')

  console.log('标题折行（决定观感，必须钉死）：')
  ok(
    titleFontSizeVw(6) === 16 && titleFontSizeVw(10) === 13,
    '短标题用最大字号',
    String(titleFontSizeVw(6))
  )
  ok(titleFontSizeVw(40) < titleFontSizeVw(12), '标题越长字号越小')
  ok(
    maxCharsPerLine(16) === 5 && maxCharsPerLine(6.5) === 13,
    '每行字数按字号反推',
    String(maxCharsPerLine(16))
  )
  ok(
    maxCharsPerLine(16, 72) < maxCharsPerLine(16, 90),
    '标题框窄的模板每行字数更少（角标卡片右侧要留位）',
    String(maxCharsPerLine(16, 72)) + ' vs ' + String(maxCharsPerLine(16, 90))
  )
  ok(
    COVER_TEMPLATES.every(
      (t) => typeof t.titleWidthPct === 'number' && t.titleWidthPct >= 50 && t.titleWidthPct <= 100
    ),
    '每个模板都声明了标题框可用宽度（折行按它算）'
  )
  const short = wrapTitle('到店必点', 5)
  ok(short.length === 1 && short[0] === '到店必点', '短标题不折行')
  const long = wrapTitle('成都人自己的火锅店人均八十吃到扶墙出', 6)
  ok(long.length >= 3, '长标题折成多行', String(long.length))
  ok(
    long.every((l) => l.length <= 6),
    '每行都不超过上限（超了会盖住主体）',
    long.join('|')
  )
  ok(
    long.every((l) => l.trim() === l && l.length > 0),
    '行首尾不带空格、无空行'
  )
  ok(long.join('') === '成都人自己的火锅店人均八十吃到扶墙出', '折行不丢字、不插字')
  const punct = wrapTitle('人均八十，锅底免费', 5)
  ok(punct[0].endsWith('，'), '过半行遇标点优先断（不把词组劈开）', punct.join('|'))
  ok(wrapTitle('', 6).length === 0 && wrapTitle('   ', 6).length === 0, '空标题 → 不产出空行')

  console.log('转义（标题是用户内容）：')
  ok(escapeHtml('<b>') === '&lt;b&gt;', '尖括号被转义')
  ok(escapeHtml('a"b\'c&d') === 'a&quot;b&#39;c&amp;d', '引号与 & 被转义')
  const evil = buildCoverHtml({ title: '<img src=x onerror=alert(1)>', width: 1024, height: 1536 })
  ok(!evil.html.includes('<img src=x'), '标题里的 HTML 不会变成真标签')
  ok(evil.html.includes('&lt;img'), '而是以转义文本呈现')

  console.log('自包含（离屏渲染必须离线可用）：')
  const noImg = buildCoverHtml({ title: '今日上新', width: 1024, height: 1024 })
  ok(!noImg.html.includes('<img'), '没有底图时不渲染 <img>')
  ok(noImg.usedImage === false, 'usedImage 如实为 false')
  const withImg = buildCoverHtml({
    title: '招牌黄牛肉',
    imageDataUri: 'data:image/png;base64,AAAA',
    width: 1024,
    height: 1536
  })
  ok(
    withImg.usedImage === true && withImg.html.includes('data:image/png;base64,AAAA'),
    '底图以 data URI 内联'
  )
  ok(!/src="https?:/.test(withImg.html), '没有外链资源（离线可渲染）')
  ok(
    withImg.html.includes('width:1024px') && withImg.html.includes('height:1536px'),
    '画布尺寸写进 CSS',
    ''
  )
  ok(
    !withImg.html.includes('http://') && !withImg.html.includes('https://'),
    '整份 HTML 不含 http(s) 链接'
  )

  console.log('字号随画布走（不能用 vw）：')
  ok(!/[0-9.]+vw/.test(withImg.html), 'HTML 里没有任何 vw 字号（vw 跟视口走，离屏窗口一变就溢出）')
  const small = buildCoverHtml({ title: '招牌黄牛肉', width: 480, height: 720 })
  const big = buildCoverHtml({ title: '招牌黄牛肉', width: 1080, height: 1440 })
  const pxOf = (html) => Number((html.match(/cover-title" style="font-size:(\d+)px/) || [])[1])
  ok(
    pxOf(small.html) === Math.round(480 * 0.16),
    '字号 = 画布宽度 × 比例',
    String(pxOf(small.html))
  )
  ok(pxOf(big.html) === Math.round(1080 * 0.16), '换画布尺寸字号等比放大', String(pxOf(big.html)))

  console.log('模板差异真的生效：')
  const a = buildCoverHtml({
    title: '同样的标题',
    templateId: 'bold-bottom',
    width: 1024,
    height: 1536
  })
  const b = buildCoverHtml({
    title: '同样的标题',
    templateId: 'top-band',
    width: 1024,
    height: 1536
  })
  ok(a.html !== b.html, '换模板产出的 HTML 不同')
  // 角标必须浅底深字：深底深字在深色照片上等于看不见（首轮预览实测）
  const badgeDoc = buildCoverHtml({ title: 'x', badge: '新店', width: 512, height: 512 })
  ok(
    badgeDoc.html.includes('background:rgba(255,255,255') && badgeDoc.html.includes('color:#111'),
    '角标是浅底深字(深底深字在深色照片上看不见)'
  )
  ok(a.templateId === 'bold-bottom' && b.templateId === 'top-band', '回执里带上实际用的模板')
  ok(a.templateLabel.length > 0 && a.templateLabel !== b.templateLabel, '模板名可展示')

  /**
   * 清单版式：参考图是「白底清单 / 备忘录截图」这类纯文字排版图时的正路
   * （实测交给扩散模型会被整张重画成美食海报）。
   */
  console.log('清单榜单版式（list）：')
  const listDoc = buildCoverHtml({
    templateId: 'list',
    title: '国庆来重庆，观音桥这家老重庆牛油锅别错过',
    subtitle: '甜品免费 · 人均98',
    badge: '观音桥',
    items: ['老重庆牛油锅 · 招牌锅底', '麻辣鸡爪', '精品牛肚', '甜品免费'],
    footNote: '眼镜火锅 · 整理',
    width: 1024,
    height: 1536
  })
  ok(listDoc.templateId === 'list', '模板命中 list')
  ok(listDoc.itemLines.length === 4, '条目逐条排出', String(listDoc.itemLines.length))
  ok(
    (listDoc.html.match(/<li>/g) || []).length === 4 &&
      listDoc.html.includes('counter-reset:cover-item'),
    '★ 序号由 CSS counter 生成（不手写数字：少一条也不会错位）'
  )
  ok(
    listDoc.html.includes('眼镜火锅 · 整理') && !listDoc.html.includes('<img class="cover-bg"'),
    '白底清单不带底图元素，底部有署名行'
  )
  ok(
    /cover-list li, .cover-list li::before\{font-size:\d+px\}/.test(listDoc.html),
    '条目字号按条数自适应（px 换算，不受 vw 影响）'
  )
  const many = buildCoverHtml({
    templateId: 'list',
    title: 't',
    items: Array.from({ length: 18 }, (_, i) => '第' + String(i + 1) + '条'),
    width: 1024,
    height: 1536
  })
  ok(many.itemLines.length === 18, '18 条也排得下（上限 20）', String(many.itemLines.length))
  ok(
    buildCoverHtml({
      templateId: 'list',
      title: 't',
      items: ['<b>坏</b>'],
      width: 800,
      height: 800
    }).html.includes('&lt;b&gt;'),
    '条目同样转义（清单内容来自模型/用户，不能把 HTML 冲掉）'
  )

  console.log('回执字段（落库/界面回显要用）：')
  const doc = buildCoverHtml({
    title: '成都人自己的火锅店人均八十',
    subtitle: '鲜切黄牛肉 每日现切',
    badge: '新店',
    imageDataUri: 'data:image/jpeg;base64,BBBB',
    width: 1024,
    height: 1536
  })
  ok(doc.lines.length > 1 && doc.fontSizeVw > 0, '回执含折行结果与字号')
  ok(doc.html.includes('鲜切黄牛肉') && doc.html.includes('新店'), '副标题与角标都进了画面')
  ok(doc.html.includes('<span>'), '标题按行渲染为独立 span（可整块定位）')
  ok(!doc.html.includes('undefined'), '没有 undefined 漏进 HTML')
} finally {
  try {
    rmSync(work, { recursive: true, force: true })
  } catch {
    /* Windows 偶发占用 */
  }
}

console.log(failed === 0 ? '\n全部通过 ✅' : '\n' + failed + ' 项失败 ❌')
process.exit(failed === 0 ? 0 : 1)
