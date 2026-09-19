/**
 * 生图策略层（**纯函数，零 IO、零依赖**，可离线自检）。
 *
 * 为什么要有它：`imageProvider.ts` 只是「通道」（把 prompt 发给 /images/generations），
 * 而「策略」——用哪个模板、按哪个平台的比例、拼哪些门店与品牌事实、要避免什么——
 * 此前完全由对话模型临场发挥：同一家店两次生图可以毫无共同点，平台比例也没人管
 * （配置里只有一个全局 size，默认还是 1024x1024 正方形，小红书封面直接构图作废）。
 *
 * 这里把策略收敛成纯函数：输入（平台 / 角色 / 模板 / 门店档案 / 品牌资料包 / 素材线索），
 * 输出（prompt / negative / size / count + 给人看的策略说明 notes）。
 * 纯函数的意义是**能离线钉死**：模板选择、比例映射、品牌调性拼装、负向词这几条一旦错了，
 * 表现只是「图不好看」，排查时没有任何报错可循，所以必须有已知答案测试。
 *
 * 约束：本文件不 import 任何东西（electron/DB/网络都不碰），自检用 esbuild 单独打包后断言。
 */

export type GrowthPlatform = 'xhs' | 'douyin' | 'moments' | 'group'
export type ImageRole = 'cover' | 'image'

export const DEFAULT_PLATFORM: GrowthPlatform = 'xhs'
export const MAX_IMAGE_COUNT = 4

/** 平台出图规格：尺寸取生图接口普遍支持的档位，比例写进 prompt 让模型按竖版/方版构图 */
export interface PlatformSpec {
  id: GrowthPlatform
  label: string
  /** 传给生图接口的 size（1024x1536 这类竖版是主流模型都支持的档位） */
  size: string
  /** 比例文案（写进 prompt，也给人看） */
  ratio: string
  /** 该平台的构图要求 */
  framing: string
}

export const PLATFORM_SPECS: Record<GrowthPlatform, PlatformSpec> = {
  xhs: {
    id: 'xhs',
    label: '小红书',
    size: '1024x1536',
    ratio: '竖版 2:3（发布为 3:4 时会裁掉少量边缘）',
    framing: '竖版构图；主体偏下三分之一，画面上方留出可叠大字标题的干净区域；色调统一、氛围感优先'
  },
  douyin: {
    id: 'douyin',
    label: '抖音',
    size: '1024x1536',
    ratio: '竖版 2:3',
    framing: '竖版构图；主体居中偏上，画面底部留出字幕/贴纸安全区；对比度略高，缩略图里也认得出主体'
  },
  moments: {
    id: 'moments',
    label: '朋友圈',
    size: '1024x1024',
    ratio: '方版 1:1',
    framing: '方版构图；一张图只讲一个卖点，主体占画面一半以上，背景干净'
  },
  group: {
    id: 'group',
    label: '客户群群发',
    size: '1024x1024',
    ratio: '方版 1:1',
    framing: '方版构图；信息直给、主体大、元素少，小屏缩略图里一眼看清'
  }
}

export function normalizePlatform(v: unknown): GrowthPlatform {
  const s = String(v ?? '')
    .trim()
    .toLowerCase()
  return s in PLATFORM_SPECS ? (s as GrowthPlatform) : DEFAULT_PLATFORM
}

export function normalizeMode(v: unknown): ImageMode {
  return String(v ?? '')
    .trim()
    .toLowerCase() === 'edit'
    ? 'edit'
    : 'gen'
}

export function normalizeRole(v: unknown): ImageRole {
  return String(v ?? '')
    .trim()
    .toLowerCase() === 'cover'
    ? 'cover'
    : 'image'
}

/** 画面模板：scene 是「画面骨架」，策略会把它与门店/品牌信息拼装成完整 prompt */
export interface ImageTemplate {
  id: string
  label: string
  roles: ImageRole[]
  scene: string
  negative: string
}

export const BUILTIN_IMAGE_TEMPLATES: ImageTemplate[] = [
  {
    id: 'dish',
    label: '菜品特写',
    roles: ['cover', 'image'],
    scene:
      '招牌菜的近距离特写，刚出锅的状态，侧逆光打在食材纹理上，浅景深背景虚化，热气隐约可见，盘边干净有细节',
    negative: '不要摆盘僵硬像菜单图，不要出现塑料道具感，不要出现文字'
  },
  {
    id: 'store',
    label: '门店环境',
    roles: ['image', 'cover'],
    scene:
      '门店堂食区实景，暖色灯光，木质桌面与餐具，有生活气息但不出现可辨认的正脸，桌上有本店招牌菜',
    negative: '不要出现可辨认的人脸，不要出现其它品牌 logo，不要出现文字'
  },
  {
    id: 'cover',
    label: '封面氛围',
    roles: ['cover'],
    scene:
      '俯拍一桌菜的场景，招牌菜在画面中心偏下，上方或下方留出大片干净可叠字的区域，色调统一、氛围松弛',
    negative: '不要出现可辨认的人脸，不要出现文字水印，不要出现其它品牌 logo'
  },
  {
    id: 'people',
    label: '人物场景',
    roles: ['image', 'cover'],
    scene: '顾客用餐的瞬间：夹菜的手部动作或背影，氛围自然不摆拍，背景是门店环境，桌上菜品清晰',
    negative: '不要出现可辨认的正脸（肖像权），不要出现文字，不要出现其它品牌 logo'
  }
]

/** 所有模板共用的负向词：这几条是「生图翻车」与合规风险的固定来源 */
export const UNIVERSAL_NEGATIVE =
  '不要生成任何文字、字幕、水印、logo 或二维码；不要出现可辨认的人脸；不要畸形的手与餐具；不要插画/卡通/3D 渲染/油画质感；不要低清晰度或过度磨皮'

export interface TemplateLibrary {
  templates: ImageTemplate[]
  source: 'builtin' | 'merged'
  error?: string
}

function asText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v.trim()
  if (Array.isArray(v))
    return v
      .map((x) => asText(x))
      .filter(Boolean)
      .join('、')
  return String(v).trim()
}

function clip(v: unknown, max: number): string {
  const s = asText(v)
  return s.length > max ? s.slice(0, max) + '…' : s
}

/**
 * 归一化一条自定义模板。
 * `base` 是它在内置库里的同 id 模板（若有）—— **只覆盖用户真写了的字段**：
 * 用户写 {`id:'dish', scene:'…'}` 时，label/roles/negative 必须继续沿用内置，
 * 否则一条只想改画面描述的配置会把内置模板的负向词与适用角色悄悄清空。
 */
function normalizeTemplate(
  raw: unknown,
  fallbackId: string,
  base?: ImageTemplate
): ImageTemplate | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const rawId = asText(o.id).toLowerCase()
  const id = rawId || base?.id || fallbackId
  if (!/^[a-z0-9_-]{1,32}$/.test(id)) return null
  const scene = clip(o.scene ?? o.prompt ?? o.desc, 400) || base?.scene || ''
  if (!scene) return null
  const roles = Array.isArray(o.roles)
    ? (o.roles.map((r) => normalizeRole(r)).filter((r, i, a) => a.indexOf(r) === i) as ImageRole[])
    : []
  const negative = 'negative' in o ? clip(o.negative, 300) : (base?.negative ?? '')
  return {
    id,
    label: clip(o.label ?? o.name, 20) || base?.label || id,
    roles: roles.length > 0 ? roles : (base?.roles ?? (['cover', 'image'] as ImageRole[])),
    scene,
    negative
  }
}

/** 这条模板原文指向内置库里的哪一条（只认显式 id） */
function baseTemplateOf(raw: unknown): ImageTemplate | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const id = asText((raw as Record<string, unknown>).id).toLowerCase()
  return id ? BUILTIN_IMAGE_TEMPLATES.find((b) => b.id === id) : undefined
}

/**
 * 解析设置里存的自定义模板库（app_config 的 growth.image.templates）。
 * 规则：留空 → 内置；同 id 覆盖内置的同名字段（可只改 scene）；新 id 追加；JSON 坏掉 → 回退内置并回报 error。
 * 兼容纯文本：整段当一条自定义模板（label=自定义），避免用户不知道要写 JSON 就整块失效。
 */
export function parseTemplateLibrary(raw: unknown): TemplateLibrary {
  const text = asText(raw)
  if (!text) return { templates: BUILTIN_IMAGE_TEMPLATES.slice(), source: 'builtin' }
  const looksJson = /^[[{]/.test(text)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // 以 { 或 [ 开头的，用户显然是想写 JSON —— 写坏了必须报出来，不能当成"随便一句画面描述"糊过去
    if (looksJson) {
      return {
        templates: BUILTIN_IMAGE_TEMPLATES.slice(),
        source: 'builtin',
        error: '模板库 JSON 解析失败（检查括号与引号），已回退内置模板'
      }
    }
    const custom = normalizeTemplate({ id: 'custom', label: '自定义', scene: text }, 'custom')
    if (!custom) {
      return {
        templates: BUILTIN_IMAGE_TEMPLATES.slice(),
        source: 'builtin',
        error: '模板库内容无法识别，已回退内置模板'
      }
    }
    return { templates: [custom, ...BUILTIN_IMAGE_TEMPLATES], source: 'merged' }
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed &&
        typeof parsed === 'object' &&
        Array.isArray((parsed as Record<string, unknown>).templates)
      ? ((parsed as Record<string, unknown>).templates as unknown[])
      : null
  if (!list) {
    return {
      templates: BUILTIN_IMAGE_TEMPLATES.slice(),
      source: 'builtin',
      error: '模板库格式不对（应为模板数组），已回退内置模板'
    }
  }
  const out: ImageTemplate[] = []
  for (const item of list) {
    // 传 base：同 id 的只覆盖用户写了的字段（见 normalizeTemplate 注释）
    const t = normalizeTemplate(item, 'tpl' + String(out.length + 1), baseTemplateOf(item))
    if (t) out.push(t)
  }
  if (out.length === 0) {
    return {
      templates: BUILTIN_IMAGE_TEMPLATES.slice(),
      source: 'builtin',
      error: '模板库条目都不可用（缺 scene），已回退内置模板'
    }
  }
  // 内置顺序优先（被覆盖的留在原位），新 id 追加到库尾
  const kept = BUILTIN_IMAGE_TEMPLATES.map((b) => out.find((t) => t.id === b.id) ?? b)
  const extras = out.filter((t) => !BUILTIN_IMAGE_TEMPLATES.some((b) => b.id === t.id))
  return { templates: [...kept, ...extras], source: 'merged' }
}

export function findTemplate(id: unknown, templates: ImageTemplate[]): ImageTemplate | null {
  const key = asText(id).toLowerCase()
  if (!key) return null
  return templates.find((t) => t.id === key) ?? null
}

/** 关键词 → 模板：只有在用户/模型明确点名了主体时才盖过角色默认模板 */
const TEMPLATE_KEYWORDS: Array<{ id: string; re: RegExp }> = [
  { id: 'dish', re: /菜品|招牌菜|出品|食材|美食|锅底|烤肉|火锅|小吃|甜品|饮品|主食/ },
  { id: 'store', re: /门店|店内|环境|堂食|装修|门头|座位|包间|明档/ },
  { id: 'people', re: /顾客|客人|人物|背影|聚餐|朋友|家人|情侣|老板|店员|服务员/ },
  { id: 'cover', re: /封面|首图|主图|叠字|大字|标题区/ }
]

export function pickTemplate(input: {
  templateId?: unknown
  role?: unknown
  userPrompt?: unknown
  templates: ImageTemplate[]
}): ImageTemplate {
  const explicit = findTemplate(input.templateId, input.templates)
  if (explicit) return explicit
  const text = asText(input.userPrompt)
  if (text) {
    for (const k of TEMPLATE_KEYWORDS) {
      if (!k.re.test(text)) continue
      const hit = input.templates.find((t) => t.id === k.id)
      if (hit) return hit
    }
  }
  const role = normalizeRole(input.role)
  const byRole = input.templates.find((t) => t.id === 'cover' && t.roles.includes(role))
  if (role === 'cover' && byRole) return byRole
  return (
    input.templates.find((t) => t.id === 'dish') ??
    input.templates[0] ?? {
      id: 'dish',
      label: '菜品特写',
      roles: ['cover', 'image'],
      scene: '',
      negative: ''
    }
  )
}

/** 品牌资料包（growth_brand_profile）解析结果 —— 纯文本也认，避免用户写不了 JSON 就整块失效 */
export interface BrandStyle {
  positioning: string
  tone: string
  visualStyle: string
  palette: string[]
  sellingPoints: string[]
  freeform: string
}

export function readBrandStyle(profileRaw: unknown): BrandStyle {
  const text = asText(profileRaw)
  const empty: BrandStyle = {
    positioning: '',
    tone: '',
    visualStyle: '',
    palette: [],
    sellingPoints: [],
    freeform: ''
  }
  if (!text) return empty
  if (!/^[[{]/.test(text)) return { ...empty, tone: clip(text, 200), freeform: clip(text, 200) }
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(text) as Record<string, unknown>
  } catch {
    return { ...empty, tone: clip(text, 200), freeform: clip(text, 200) }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return empty
  const palette = Array.isArray(obj.palette ?? obj.colors)
    ? ((obj.palette ?? obj.colors) as unknown[])
        .map((c) => clip(c, 16))
        .filter(Boolean)
        .slice(0, 6)
    : []
  const sellingPoints = Array.isArray(obj.sellingPoints ?? obj.selling_points)
    ? ((obj.sellingPoints ?? obj.selling_points) as unknown[])
        .map((c) => clip(c, 24))
        .filter(Boolean)
        .slice(0, 8)
    : []
  return {
    positioning: clip(obj.positioning ?? obj.position, 80),
    tone: clip(obj.tone ?? obj.voice, 80),
    visualStyle: clip(obj.visualStyle ?? obj.style, 120),
    palette,
    sellingPoints,
    freeform: ''
  }
}

/**
 * 视觉拆解（growth_decomp.visual_json）解析结果 —— 图生图「保持什么」的事实来源。
 *
 * 为什么单独一套：文字拆解说的是「这条为什么有效」，与画面的构图/机位/光线无关。
 * 有了这些字段，「保持」才能写成「构图：居中对称；机位：90 度俯拍；光线：侧逆光」，
 * 而不是让模型自己看图猜 —— 猜错的表现就是改出来不是同一个版式。
 */
export interface VisualFacts {
  composition: string
  camera: string
  lighting: string
  colorTone: string
  layout: string
  subjectRatio: string
  elements: string[]
  textInImage: string
}

/** 模型爱用「空 / 无 / 没有」表示"图上没有文字"，这些都不算事实 */
const NO_VALUE_RE = /^(空|无|没有|none|n\/a|-{1,2})$/i

/**
 * 读取视觉拆解。容错三种输入：已解析对象、JSON 文本（库里存的是字符串）、null/坏值。
 * 也容忍模型换个键名（如 cameraAngle / 色调写 tone），只要能读懂就别让整块失效。
 */
export function readVisualFacts(raw: unknown): VisualFacts {
  const empty: VisualFacts = {
    composition: '',
    camera: '',
    lighting: '',
    colorTone: '',
    layout: '',
    subjectRatio: '',
    elements: [],
    textInImage: ''
  }
  let obj: Record<string, unknown> | null = null
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) obj = raw as Record<string, unknown>
  else {
    const text = asText(raw)
    if (!text || !text.startsWith('{')) return empty
    try {
      const parsed = JSON.parse(text) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        obj = parsed as Record<string, unknown>
      }
    } catch {
      return empty
    }
  }
  if (!obj) return empty
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const s = clip(obj?.[k], 60)
      if (s) return s
    }
    return ''
  }
  const rawElements = obj.elements ?? obj.props ?? obj.objects
  const elements = Array.isArray(rawElements)
    ? rawElements
        .map((x) => clip(x, 20))
        .filter(Boolean)
        .slice(0, 8)
    : []
  // 只认明确的「图上文字」键名：退到泛化的 text 会把正文当图上文字写进负向词
  const textInImage = pick('textInImage', 'text_in_image', 'overlayText', 'imageText')
  return {
    composition: pick('composition', 'layout_structure'),
    camera: pick('camera', 'cameraAngle', 'shot', 'angle'),
    lighting: pick('lighting', 'light'),
    colorTone: pick('colorTone', 'color', 'tone', 'palette'),
    layout: pick('layout', 'whitespace', 'textLayout'),
    subjectRatio: pick('subjectRatio', 'subject_ratio', 'subject'),
    elements,
    textInImage: NO_VALUE_RE.test(textInImage) ? '' : textInImage
  }
}

/** 视觉拆解里有没有真的可用的事实（全空就当没有，别拿空对象去改写提示词） */
export function hasVisualFacts(v: VisualFacts): boolean {
  return Boolean(
    v.composition ||
    v.camera ||
    v.lighting ||
    v.colorTone ||
    v.layout ||
    v.subjectRatio ||
    v.elements.length > 0
  )
}

/** 门店档案里与「画面」有关的事实 —— 只取真的能拍出来的东西，电话/营业时间不参与构图 */
export function readStoreVisualFacts(
  profileRaw: unknown,
  fallback: { name?: unknown; city?: unknown; bizType?: unknown } = {}
): { signatureDishes: string; packages: string; note: string; tone: string; bannedWords: string } {
  const out = { signatureDishes: '', packages: '', note: '', tone: '', bannedWords: '' }
  const text = asText(profileRaw)
  let obj: Record<string, unknown> = {}
  if (text && /^[[{]/.test(text)) {
    try {
      const parsed = JSON.parse(text) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        obj = parsed as Record<string, unknown>
    } catch {
      obj = {}
    }
  }
  out.signatureDishes = clip(obj.signatureDishes ?? obj.dishes, 120)
  out.packages = clip(obj.packages, 120)
  out.note = clip(obj.note, 160)
  out.tone = clip(obj.tone, 60)
  out.bannedWords = clip(obj.bannedWords, 120)
  const bits = [asText(fallback.city), asText(fallback.bizType)].filter(Boolean)
  if (bits.length > 0 && out.note) out.note = clip(out.note + '；' + bits.join('·'), 200)
  return out
}

export interface ImageStrategyInput {
  /** 模型/用户给的画面描述（可空，空则完全用模板骨架） */
  userPrompt?: unknown
  /** 目标平台：xhs | douyin | moments | group */
  platform?: unknown
  /**
   * gen = 凭描述生成全新画面；edit = **在参考图上改写**（图生图）。
   * edit 的 prompt 结构与 gen 完全不同：前者说"画什么"，后者要说"什么保持不变、什么换成我家的"。
   */
  mode?: unknown
  /**
   * 随请求附上的参考图张数（0 = 纯文本；1 = 只有结构模板；2 = 结构模板 + 本店实拍）。
   * 多图时 prompt 必须写清「图1 / 图2 各是什么」，否则模型会把两张图混着用。
   */
  referenceCount?: unknown
  /** cover（封面）| image（正文图） */
  role?: unknown
  /** 指定模板 id（不指定则按 prompt 关键词 / 角色自动选） */
  templateId?: unknown
  /** 想要几张 */
  count?: unknown
  /** 单次张数上限（来自配置 growth.image.count） */
  maxCount?: unknown
  /** 每月张数上限（来自配置 growth.image.monthlyLimit；0/空 = 不限） */
  monthlyLimit?: unknown
  /** 本月已生成张数（调用方查库后传入 —— 本文件保持无 IO） */
  usedThisMonth?: unknown
  /** 自定义模板库原文（app_config growth.image.templates） */
  templateLibraryRaw?: unknown
  /** 显式尺寸覆盖（设置里填了才用） */
  size?: unknown
  /** 门店（listStores 的行；profile 是 JSON 文本） */
  store?: {
    name?: unknown
    brandName?: unknown
    city?: unknown
    bizType?: unknown
    profile?: unknown
  } | null
  /** 品牌资料包（getBrandProfile 的行） */
  brand?: { name?: unknown; profile?: unknown } | null
  /** 素材线索：菜品名/场景/用途等，来自 itemBrief */
  materialHint?: unknown
  /**
   * 结构参考图的**视觉拆解**（growth_decomp.visual_json 原文）。
   * 只在 edit 模式用得上：它把「保持构图机位光线」从一句套话变成具体清单。
   */
  referenceVisual?: unknown
}

export type ImageMode = 'gen' | 'edit'

export interface ImageStrategy {
  mode: ImageMode
  templateId: string
  templateLabel: string
  platform: GrowthPlatform
  platformLabel: string
  role: ImageRole
  roleLabel: string
  size: string
  ratio: string
  /** 本次实际要生成的张数（已按单次上限与月度额度收敛；blocked 时为 0） */
  count: number
  /** 本月额度剩余（null = 未设上限） */
  remaining: number | null
  /** 额度耗尽：此时 count=0，**不得发起生成** */
  blocked: boolean
  /** 额度耗尽原因（直接给用户/模型看，别只说"失败"） */
  blockedReason?: string
  /** 正向描述（不含负向词） */
  prompt: string
  /** 负向词 */
  negative: string
  /** 真正发给接口的完整 prompt */
  finalPrompt: string
  /** 给人看的策略说明（落库 + 界面回显，让「策略」看得见） */
  notes: string[]
  /** 图生图的「保持」用了素材的视觉拆解（真·锁定版式）而不是通用口径 */
  visualLocked: boolean
  /** 模板库本身的问题（JSON 坏掉等），要如实告诉用户而不是静默回退 */
  warning?: string
}

const SIZE_RE = /^\d{2,5}x\d{2,5}$/

export function parseSize(size: unknown): { width: number; height: number } | null {
  const s = asText(size).toLowerCase().replace(/\s/g, '')
  if (!SIZE_RE.test(s)) return null
  const [w, h] = s.split('x')
  const width = Number(w)
  const height = Number(h)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return { width, height }
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

/** 负向词与正向描述合成最终 prompt：接口层不保证都支持 negative_prompt，拼进文本最通用 */
export function composeFinalPrompt(prompt: string, negative: string): string {
  const p = asText(prompt)
  const n = asText(negative)
  if (!n) return p
  return p + '\n\n【避免出现】' + n
}

function joinFacts(parts: string[]): string {
  return parts.filter((x) => asText(x)).join('；')
}

/**
 * 核心：产出一次生图要用的全部参数。
 * 组装顺序固定（主体 → 模板骨架 → 门店元素 → 品牌调性 → 平台构图 → 摄影要求），
 * 顺序本身是契约：门店事实在前、平台构图在后，模型才不会为了构图把招牌菜改掉。
 */
export function buildImageStrategy(input: ImageStrategyInput): ImageStrategy {
  const notes: string[] = []
  const lib = parseTemplateLibrary(input.templateLibraryRaw)
  const platform = normalizePlatform(input.platform)
  const spec = PLATFORM_SPECS[platform]
  const role = normalizeRole(input.role)
  const template = pickTemplate({
    templateId: input.templateId,
    role,
    userPrompt: input.userPrompt,
    templates: lib.templates
  })
  const limit = clampInt(input.maxCount, 1, MAX_IMAGE_COUNT, MAX_IMAGE_COUNT)
  const requested = clampInt(input.count, 1, MAX_IMAGE_COUNT, limit)
  // 两道闸门：单次上限 → 月度额度。额度这道是花钱的闸门，必须在这里收敛，
  // 而不是等接口报错（接口不报错，它只会照单生成然后计费）。
  const afterPerRun = Math.min(requested, limit)
  const monthlyLimit = clampInt(input.monthlyLimit, 0, 100000, 0)
  const used = clampInt(input.usedThisMonth, 0, 1000000, 0)
  const remaining = monthlyLimit > 0 ? Math.max(monthlyLimit - used, 0) : null
  const blocked = remaining !== null && remaining <= 0
  const count = blocked ? 0 : remaining === null ? afterPerRun : Math.min(afterPerRun, remaining)
  const explicitSize = asText(input.size)
  const size = SIZE_RE.test(explicitSize) ? explicitSize : spec.size

  const userPrompt = clip(input.userPrompt, 400)
  const subject = userPrompt || template.scene

  const store = input.store ?? null
  const facts = readStoreVisualFacts(store?.profile, {
    city: store?.city,
    bizType: store?.bizType
  })
  const storeName = asText(store?.brandName) || asText(store?.name)

  const brand = input.brand ?? null
  const style = readBrandStyle(brand?.profile)
  const brandName = asText(brand?.name) || ''

  const mode = normalizeMode(input.mode)
  const visual = readVisualFacts(input.referenceVisual)
  /** 视觉拆解只在图生图里说话；没有它（旧卡/没拆过）就退回通用口径 */
  const visualOn = mode === 'edit' && hasVisualFacts(visual)
  const referenceCount = clampInt(input.referenceCount, 0, 8, 0)
  /** 多图时指向「结构模板」那一张：prompt 里所有"保持/不要带出"都该说图1，而不是笼统的"参考图" */
  const refTag = referenceCount >= 2 ? '图1' : '参考图'
  const lines: string[] = []
  if (mode === 'edit') {
    // 图生图：参考图提供了画面结构，prompt 要说的不是「画什么」，而是
    // **什么保持不变、什么换成我家的、什么是绝对不要的**（三段固定，别混在一句话里）。
    if (referenceCount >= 2) {
      lines.push(
        '改写任务：随本次请求附上 2 张参考图。【图1】是结构模板，只借它的构图/机位/光线/留白/氛围；' +
          '【图2】是本店的真实实拍，画面里的菜品与场景**以图2 为准**（图2 里没有的东西不要出现在结果里）。'
      )
    } else {
      lines.push('改写任务：以随本次请求附上的参考图为基础改图，不是凭描述画一张新图。')
    }
    // 有视觉拆解就逐项点名要保持什么（这是「同一个版式换内容」成败的关键）；
    // 没有就退回通用口径 —— 通用口径也能用，只是模型得自己看图猜构图。
    const holdBits = visualOn
      ? joinFacts([
          visual.composition ? '构图：' + visual.composition : '',
          visual.camera ? '机位与视角：' + visual.camera : '',
          visual.lighting ? '光线：' + visual.lighting : '',
          visual.colorTone ? '色调：' + visual.colorTone : '',
          visual.layout ? '版式与留白：' + visual.layout : '',
          visual.subjectRatio ? '主体占比与位置：' + visual.subjectRatio : '',
          visual.elements.length > 0
            ? '画面元素（道具/桌面/背景，不含菜品）：' + visual.elements.join('/')
            : ''
        ])
      : ''
    lines.push(
      '【保持】' +
        refTag +
        '的' +
        (holdBits
          ? holdBits + '；只改内容，不要改版式'
          : '构图与机位、镜头与光线、场景氛围、画面留白位置、主体在画面里的占比；只改内容，不要改版式')
    )
    if (userPrompt) lines.push('【本次要求】' + userPrompt)
  } else {
    lines.push('画面主体：' + subject)
    if (userPrompt && template.scene) lines.push('场景范式：' + template.scene)
  }

  const storeFacts = joinFacts([
    storeName ? '门店：' + storeName : '',
    facts.signatureDishes ? '招牌菜：' + facts.signatureDishes : '',
    facts.packages ? '套餐：' + facts.packages : '',
    facts.note ? '场景线索：' + facts.note : ''
  ])
  if (storeFacts) {
    lines.push(
      (mode === 'edit'
        ? '【替换为本店真实信息】把' +
          refTag +
          '里的菜品/场景/门店元素换成下面这些；只能用这些事实、不要编造其它菜品：'
        : '画面里可以出现的真实元素（只能用这些，不要编造其它菜品）：') + storeFacts
    )
  }

  const brandBits = joinFacts([
    brandName && brandName !== storeName ? '品牌：' + brandName : '',
    style.positioning ? '定位：' + style.positioning : '',
    style.tone || facts.tone ? '调性：' + (style.tone || facts.tone) : '',
    style.visualStyle ? '视觉风格：' + style.visualStyle : '',
    style.palette.length > 0 ? '主色调：' + style.palette.join('/') : ''
  ])
  if (brandBits) lines.push((mode === 'edit' ? '【品牌口径】' : '品牌口径：') + brandBits)

  lines.push('平台构图（' + spec.label + ' · ' + spec.ratio + '）：' + spec.framing)
  lines.push(
    '摄影要求：真实门店实拍质感（手机随手拍的自然光感），主体清晰、背景干净，不做广告棚拍的精修感'
  )

  const negative = joinFacts([
    template.negative,
    // 图生图最要命的一条：参考图是别人的作品，像素级特征（原文字/水印/logo/人脸）绝不能带出来
    mode === 'edit' ? '不要保留' + refTag + '里的任何文字、Logo、水印、二维码' : '',
    // 把参考图上原有的文字点名写出来：只说"不要文字"时，模型常把原字照抄进新图（尤其大字贴纸）
    visualOn && visual.textInImage
      ? '不要带出' +
        refTag +
        '上的原有文字（原文：' +
        visual.textInImage +
        '），换成上面给出的本店信息'
      : '',
    mode === 'edit' ? '不要照抄' + refTag + '的菜品摆盘与人物，要换成上面给出的本店信息' : '',
    facts.bannedWords ? '不要出现这些词/' + facts.bannedWords : '',
    UNIVERSAL_NEGATIVE
  ])

  const prompt = lines.join('\n')
  const finalPrompt = composeFinalPrompt(prompt, negative)

  notes.push(
    mode === 'edit'
      ? '模式：图生图（' +
          (referenceCount >= 2 ? '图1 结构模板 + 图2 本店实拍，' : '') +
          '保持构图，替换为本店信息）'
      : '模式：文生图'
  )
  if (visualOn) {
    notes.push(
      '视觉拆解：' +
        clip(joinFacts([visual.composition, visual.camera, visual.lighting, visual.layout]), 80) +
        '（据此锁定「保持」清单）'
    )
  } else if (mode === 'edit') {
    notes.push('提示：这条素材没有视觉拆解，「保持」用的是通用口径（构图/机位/光线不具体）')
  }
  notes.push('模板：' + template.label + '（' + template.id + '）')
  notes.push('平台：' + spec.label + ' · ' + spec.ratio + ' · ' + size)
  notes.push('角色：' + (role === 'cover' ? '封面' : '正文图') + ' · ' + String(count) + ' 张')
  if (storeName)
    notes.push('门店元素：' + joinFacts([storeName, facts.signatureDishes]).slice(0, 60))
  if (brandBits) notes.push('品牌口径：' + clip(brandBits, 80))
  if (!blocked && count < requested) {
    notes.push('张数被单次上限压到 ' + String(count) + '（设置 → AI 生图 的「每次张数」）')
  }
  if (remaining !== null) {
    notes.push(
      '本月额度：已用 ' +
        String(used) +
        ' / ' +
        String(monthlyLimit) +
        ' 张' +
        (blocked
          ? '，已用尽'
          : remaining < afterPerRun
            ? '，本次只生成剩余的 ' + String(remaining) + ' 张'
            : '，剩余 ' + String(remaining) + ' 张')
    )
  }
  if (lib.source === 'merged')
    notes.push('模板库：使用自定义模板（' + String(lib.templates.length) + ' 条）')

  const out: ImageStrategy = {
    mode,
    templateId: template.id,
    templateLabel: template.label,
    platform,
    platformLabel: spec.label,
    role,
    roleLabel: role === 'cover' ? '封面' : '正文图',
    size,
    ratio: spec.ratio,
    count,
    remaining,
    blocked,
    prompt,
    negative,
    finalPrompt,
    notes,
    visualLocked: visualOn
  }
  if (blocked) {
    out.blockedReason =
      '本月生图已达上限 ' +
      String(monthlyLimit) +
      ' 张（已生成 ' +
      String(used) +
      ' 张）。到 设置 → AI 生图 → 每月张数上限 调高额度，或等下月；也可以改用门店实拍图。'
    notes.push('已拦截：本月额度用尽，未发起生成')
  }
  if (lib.error) out.warning = lib.error
  return out
}

/** 一行给人看的策略摘要（工具回执、日志、界面都用它） */
export function formatStrategy(s: ImageStrategy): string {
  return joinFacts([
    s.templateLabel,
    s.platformLabel + ' ' + s.ratio,
    s.size,
    s.roleLabel,
    String(s.count) + ' 张'
  ])
}
