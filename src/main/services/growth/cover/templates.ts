/**
 * 封面模板引擎（**纯函数，零 IO、零依赖**，可离线自检）。
 *
 * 为什么要有它：小红书图文的封面价值大半在「实拍图 + 大字标题」的排版上，
 * 而本应用此前只能把裸图当封面 —— 刚爆改出来的标题落不到图上。
 *
 * 实现路子：**不引任何图像库**，由本模块生成一份自包含的 HTML（内联 CSS + data: URI 底图），
 * 交给 Electron 离屏渲染后截图为 PNG（见 ./renderer.ts）。好处是排版直接用 CSS，
 * 中文字体用系统字体，且整条链路没有原生依赖需要跟着 Electron 重新编译。
 *
 * 约束：不 import 任何东西（DB/electron/网络都不碰），自检用 esbuild 单独打包后断言。
 */

export interface CoverTemplate {
  id: string
  label: string
  /** 一句话说明适用场景（给模型与用户挑模板用） */
  when: string
  /**
   * 标题框的可用宽度（百分比）。
   * 折行必须按它算：各模板标题框宽度不同（角标卡片右侧要留角标位，只有 72%），
   * 若一律按 86% 折行，行会超出框宽被 CSS 二次折行 —— 排版直接垮掉。
   */
  titleWidthPct: number
  /** 追加在基础样式之后的 CSS（越靠后优先级越高，模板靠它覆盖 .cover-title 等） */
  css: string
}

export const COVER_TEMPLATES: CoverTemplate[] = [
  {
    /**
     * 清单/榜单版式：白底 + 大标题 + 逐条列表 + 底部品牌行。
     *
     * 场景（实测得出）：参考图是「备忘录截图 / 白底清单」这类**纯文字排版图**时，
     * 图生图只会把它重画成别的东西（模型没有"画面"可保，只剩文字，而文字它要重画），
     * 而这种图的价值恰恰是「格式一样、只换文字」——那就该本地排。
     * 条目数不设死，字号按条数自适应（见 .cover-list）。
     */
    id: 'list',
    label: '清单榜单',
    when: '参考图是白底清单/备忘录截图（纯文字排版、没有实拍画面）时：逐条列出店名或推荐',
    titleWidthPct: 90,
    css: [
      '.cover-stage{background:#fff}',
      '.cover-scrim{display:none}',
      '.cover-title{left:5%;right:5%;top:4%;color:#111;text-align:left;font-weight:800}',
      '.cover-sub{left:5%;right:5%;top:calc(4% + 9.5em);color:#666;font-weight:500}',
      '.cover-badge{right:5%;top:4%;background:#e03131;color:#fff}',
      '.cover-list{position:absolute;left:5%;right:5%;top:22%;bottom:9%;margin:0;padding:0;list-style:none;' +
        'counter-reset:cover-item;overflow:hidden}',
      '.cover-list li{position:relative;padding:0 0 0 8.5%;margin:0 0 1.6%;font-size:3.4vw;line-height:1.42;' +
        'color:#222;font-weight:500}',
      '.cover-list li::before{counter-increment:cover-item;content:counter(cover-item);position:absolute;' +
        'left:0;top:.1em;width:6%;text-align:right;color:#e03131;font-weight:800;font-size:3.4vw}',
      '.cover-foot{position:absolute;left:5%;right:5%;bottom:3.5%;color:#999;font-size:2.8vw;' +
        'border-top:1px solid #eee;padding-top:1.6%}'
    ].join('\n')
  },
  {
    id: 'bold-bottom',
    label: '大字压底',
    when: '最通用的小红书封面：底图铺满，标题大字压在底部渐变上',
    titleWidthPct: 88,
    css: [
      '.cover-scrim{background:linear-gradient(to top,rgba(0,0,0,.86) 0%,rgba(0,0,0,.45) 38%,rgba(0,0,0,.12) 62%,rgba(0,0,0,.28) 100%)}',
      '.cover-title{left:6%;right:6%;bottom:8%;color:#fff;text-shadow:0 2px 14px rgba(0,0,0,.6)}',
      '.cover-sub{left:6%;right:6%;bottom:4.2%;color:rgba(255,255,255,.94)}',
      // 角标一律浅底深字：深底深字在深色照片上等于看不见（首轮预览实测）
      '.cover-badge{left:6%;top:6%}'
    ].join('\n')
  },
  {
    id: 'top-band',
    label: '顶部色块',
    when: '信息型内容：顶部一条深色块放标题，主体画面完整露出',
    titleWidthPct: 90,
    css: [
      '.cover-scrim{background:linear-gradient(to bottom,rgba(0,0,0,.86) 0%,rgba(0,0,0,.52) 26%,rgba(0,0,0,0) 46%)}',
      '.cover-title{left:5%;right:5%;top:5%;color:#fff;text-align:left}',
      '.cover-sub{left:5%;right:5%;bottom:6%;color:#fff;background:rgba(0,0,0,.55);padding:1.4% 2.4%;border-radius:6px;display:inline-block}',
      '.cover-badge{right:5%;top:5%}'
    ].join('\n')
  },
  {
    id: 'corner-card',
    label: '角标卡片',
    when: '主体要完整（菜品/环境），标题缩到左下角半透明卡片里',
    // 右侧留角标位：标题框只有 72% 宽，折行必须按这个宽度算
    titleWidthPct: 72,
    css: [
      '.cover-scrim{background:linear-gradient(to top,rgba(0,0,0,.55),rgba(0,0,0,0) 45%)}',
      '.cover-title{left:5%;right:22%;bottom:7%;color:#fff;background:rgba(0,0,0,.62);padding:3.2% 3.6%;border-radius:10px;backdrop-filter:blur(2px)}',
      '.cover-sub{left:5%;right:22%;bottom:2.6%;color:rgba(255,255,255,.92)}',
      '.cover-badge{right:5%;bottom:7%}'
    ].join('\n')
  },
  {
    id: 'plain-center',
    label: '纯文字居中',
    when: '没有可用底图时（或刻意做纯文字封面）：整屏大标题居中',
    titleWidthPct: 84,
    css: [
      '.cover-scrim{background:rgba(17,17,17,.62)}',
      '.cover-title{left:8%;right:8%;top:50%;transform:translateY(-50%);color:#fff;text-align:center}',
      '.cover-sub{left:8%;right:8%;bottom:12%;color:rgba(255,255,255,.9);text-align:center}',
      '.cover-badge{left:50%;top:8%;transform:translateX(-50%)}'
    ].join('\n')
  }
]

export const DEFAULT_COVER_TEMPLATE = 'bold-bottom'

export function findCoverTemplate(id: unknown): CoverTemplate {
  const key = String(id ?? '')
    .trim()
    .toLowerCase()
  return (
    COVER_TEMPLATES.find((t) => t.id === key) ??
    (COVER_TEMPLATES.find((t) => t.id === DEFAULT_COVER_TEMPLATE) as CoverTemplate)
  )
}

/** 标题字号（vw = 画面宽度的百分比，因此与出图尺寸无关，1024 与 1080 都排得下） */
export function titleFontSizeVw(length: number): number {
  const n = Math.max(0, Math.floor(Number(length) || 0))
  if (n <= 6) return 16
  if (n <= 10) return 13
  if (n <= 16) return 10.5
  if (n <= 24) return 8
  return 6.5
}

/**
 * 每行最多几个字：按「该模板的标题框宽度 ÷ 字号」反推（中文字宽 ≈ 1em）。
 * 宽度必须由模板给（见 titleWidthPct），否则行会超出标题框被 CSS 二次折行。
 */
export function maxCharsPerLine(fontSizeVw: number, titleWidthPct = 86): number {
  const width = Number.isFinite(titleWidthPct) ? titleWidthPct : 86
  return Math.max(3, Math.floor(width / Math.max(1, fontSizeVw)))
}

const BREAK_AFTER = '，。！？、；：,.!?;:）)》」】 '

/**
 * 标题折行：中文按字折，遇到标点/空格且已过半行就优先在那里断，避免把词组劈开。
 * 折行结果直接决定画面观感，所以做成纯函数钉死（第 1 行不能是空的、每行不超上限）。
 */
export function wrapTitle(title: string, maxChars: number): string[] {
  const text = String(title ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return []
  const limit = Math.max(1, Math.floor(maxChars))
  const lines: string[] = []
  let cur = ''
  for (const ch of text) {
    cur += ch
    const full = cur.length >= limit
    const soft = cur.length >= Math.ceil(limit * 0.6) && BREAK_AFTER.includes(ch)
    if (full || soft) {
      lines.push(cur.trim())
      cur = ''
    }
  }
  if (cur.trim()) lines.push(cur.trim())
  return lines.filter((l) => l !== '')
}

export function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export interface CoverInput {
  templateId?: unknown
  /** 封面大字标题（通常就是采纳的那条标题） */
  title: string
  subtitle?: string
  /** 角标短词，如「新店」「人均 80」 */
  badge?: string
  /**
   * 清单条目（「清单/榜单」版式用）：一行一条，逐条本地渲染。
   * 为什么需要：参考图本身是「白底清单/备忘录截图」时，扩散生图只会把它重画成别的画面
   * （实测），而这种版式的本质就是**文字排版**——交给本地渲染才逐字准确、格式一致。
   */
  items?: string[]
  /** 清单版式底部的署名行（如品牌名/门店名），可空 */
  footNote?: string
  /** 底图 data URI（没有则渲染纯文字封面） */
  imageDataUri?: string
  width: number
  height: number
}

export interface CoverDoc {
  html: string
  templateId: string
  templateLabel: string
  /** 折行后的标题（落库/回执里能看到实际怎么排的） */
  lines: string[]
  fontSizeVw: number
  usedImage: boolean
  /** 清单版式实际排出的条目（回执/落库能看到排了几条） */
  itemLines: string[]
}

const BASE_CSS = [
  'html,body{margin:0;padding:0;overflow:hidden;background:#111;',
  'font-family:"Microsoft YaHei","PingFang SC","Hiragino Sans GB","Noto Sans CJK SC",sans-serif}',
  '.cover-stage{position:relative;overflow:hidden;background:#111}',
  '.cover-bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}',
  '.cover-scrim{position:absolute;inset:0}',
  '.cover-title{position:absolute;font-weight:800;line-height:1.26;letter-spacing:.01em;word-break:break-word}',
  '.cover-title span{display:block}',
  '.cover-sub{position:absolute;line-height:1.4;font-weight:500}',
  '.cover-badge{position:absolute;line-height:1;font-weight:700;border-radius:999px;background:rgba(255,255,255,.94);color:#111;box-shadow:0 2px 10px rgba(0,0,0,.35)}'
].join('\n')

/**
 * 生成一份自包含封面 HTML：不引用任何外部资源（底图走 data: URI），
 * 因此离屏窗口可以离线渲染，也不会因为网络抖动出半张图。
 */
export function buildCoverHtml(input: CoverInput): CoverDoc {
  const tpl = findCoverTemplate(input.templateId)
  const width = Math.max(64, Math.round(Number(input.width) || 1024))
  const height = Math.max(64, Math.round(Number(input.height) || 1024))
  const title = String(input.title ?? '').trim()
  const fontSizeVw = titleFontSizeVw([...title].length)
  const lines = wrapTitle(title, maxCharsPerLine(fontSizeVw, tpl.titleWidthPct))
  const imageDataUri = String(input.imageDataUri ?? '')
  const usedImage = imageDataUri.startsWith('data:image/')

  const bg = usedImage ? '<img class="cover-bg" src="' + escapeHtml(imageDataUri) + '" alt="">' : ''
  const badge = String(input.badge ?? '').trim()
  const subtitle = String(input.subtitle ?? '').trim()
  /**
   * 字号一律换算成**画布宽度的百分比对应的 px**，不用 vw。
   * 踩过的坑：vw 是「视口宽度」，离屏窗口一旦不是正好等于画布尺寸（多一像素边框、
   * 系统缩放、预览环境），整张封面的字就会放大到溢出画面 —— 实测 480px 画布配 1256px 视口时，
   * 一行标题渲染成 1013px 高。px 只跟画布走，任何环境都稳。
   */
  const px = (pct: number): number => Math.max(1, Math.round((width * pct) / 100))
  /**
   * 清单条目：一行一条，逐条渲染（第 1..N 条的序号由 CSS counter 出，不用手写数字 ——
   * 手写数字在"少一条"时会与列表错位）。条目字号按条数自适应：
   * 12 条塞满 3:4 画面时用小字，3 条时放大，避免"字太大溢出 / 字太小看不清"。
   */
  const items = (Array.isArray(input.items) ? input.items : [])
    .map((x) => String(x ?? '').trim())
    .filter((x) => x !== '')
    .slice(0, 20)
  const itemFontVw = items.length > 14 ? 2.7 : items.length > 9 ? 3.1 : items.length > 6 ? 3.4 : 3.9
  const sizeCss = [
    '.cover-sub{font-size:' + String(px(2.9)) + 'px}',
    '.cover-badge{font-size:' +
      String(px(2.6)) +
      'px;padding:' +
      String(px(1.1)) +
      'px ' +
      String(px(1.8)) +
      'px}',
    // 清单条目字号：按条数自适应（模板 CSS 里写的是 vw，这里用 px 覆盖掉）
    '.cover-list li, .cover-list li::before{font-size:' + String(px(itemFontVw)) + 'px}',
    '.cover-foot{font-size:' + String(px(2.8)) + 'px}',
    '.cover-list{top:' +
      String(px(items.length > 14 ? 20 : 22)) +
      '%;bottom:' +
      String(px(9)) +
      '%}'
  ].join('\n')
  const titleHtml = lines.length
    ? '<div class="cover-title" style="font-size:' +
      String(px(fontSizeVw)) +
      'px">' +
      lines.map((l) => '<span>' + escapeHtml(l) + '</span>').join('') +
      '</div>'
    : ''

  const listHtml = items.length
    ? '<ol class="cover-list">' +
      items.map((it) => '<li>' + escapeHtml(it) + '</li>').join('') +
      '</ol>'
    : ''
  const footHtml = items.length
    ? '<div class="cover-foot">' +
      escapeHtml(String(input.footNote ?? '').trim() || '整理 · 供参考') +
      '</div>'
    : ''

  const html = [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<style>',
    BASE_CSS,
    '.cover-stage{width:' + String(width) + 'px;height:' + String(height) + 'px}',
    tpl.css,
    // 计算出来的字号放最后：模板 CSS 不得反过来把它覆盖掉
    sizeCss,
    '</style></head><body>',
    '<div class="cover-stage">',
    bg,
    '<div class="cover-scrim"></div>',
    badge ? '<div class="cover-badge">' + escapeHtml(badge) + '</div>' : '',
    titleHtml,
    subtitle ? '<div class="cover-sub">' + escapeHtml(subtitle) + '</div>' : '',
    listHtml,
    footHtml,
    '</div></body></html>'
  ].join('')

  return {
    html,
    templateId: tpl.id,
    templateLabel: tpl.label,
    lines,
    fontSizeVw,
    usedImage,
    itemLines: items
  }
}
