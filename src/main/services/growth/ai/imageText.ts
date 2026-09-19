/**
 * 生图产物的**文字校对**与「该不该交给扩散模型」的分流判据（纯函数，可离线自检）。
 *
 * 为什么要有它：2026-09-19 在本机通道上实测（原图 + 「保持版式只换文字」提示词）——
 *  - 中文渲染出乎意料地准（逐字正确），但**新文案比原文案长时会被裁**（标题左端被切掉）；
 *  - 参考图若是「白底清单/备忘录截图」这类**纯文字排版图**，模型会把它重画成美食海报
 *    （它没有"画面"可保持，只剩要重画的文字）。
 * 这两件事提示词压不住 —— 只能靠**出图后回读比对**和**按画面事实分流**。
 */

/** 归一化：去空白/标点差异，全角数字与字母折半角，便于"逐字比对"而不是"格式比对" */
export function normalizeForCompare(s: unknown): string {
  return String(s ?? '')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s]+/g, '')
    .replace(/[·•・~〜\-—_]/g, '')
    .replace(/[，,。.、；;：:！!？?「」『』“”"'()（）[\]【】]/g, '')
    .toLowerCase()
}

export interface TextVerifyResult {
  /** 逐行结果（保持传入顺序，便于按行报告） */
  lines: Array<{ expected: string; found: boolean }>
  /** 全部命中 */
  allFound: boolean
  /** 命中行数 / 总行数 */
  matched: number
  total: number
}

/**
 * 把「我要求写的文字」与「从产物里读回来的文字」逐行比对。
 * 判据是**包含**（读回文本通常是整段，模型会把多行连起来读），并做标点/空白归一化 ——
 * 否则"甜品免费 · 人均98"与"甜品免费·人均 98"会被误判为不一致。
 */
export function verifyTextLines(expectedLines: string[], readBack: string): TextVerifyResult {
  const got = normalizeForCompare(readBack)
  const lines = expectedLines
    .map((x) => String(x ?? '').trim())
    .filter((x) => x !== '')
    .map((expected) => {
      const key = normalizeForCompare(expected)
      return { expected, found: key.length > 0 && got.includes(key) }
    })
  const matched = lines.filter((l) => l.found).length
  return {
    lines,
    allFound: lines.length > 0 && matched === lines.length,
    matched,
    total: lines.length
  }
}

/** 回读用的提示词：只让它"照抄看到的字"，不要解释、不要补全 */
export function buildReadBackPrompt(): string {
  return [
    '逐字读出这张图中出现的**全部文字**（包括标题、副标题、角标、小字与数字），不要翻译、不要解释、不要补全看不清的字。',
    '只输出一个 JSON 对象：{ "lines": ["第一行", "第二行"] }，按从上到下、从左到右的顺序；看不清的字用 ? 代替。'
  ].join('\n')
}

/** 交接给本地排版时给模型的文字要求（清单版式） */
export interface TextOnlyVerdict {
  /** 是否判定为「纯文字排版图」（不该交给扩散模型） */
  textOnly: boolean
  /** 判据（写进回执，让用户/模型知道为什么这么判） */
  reasons: string[]
}

const TEXT_ONLY_PATTERNS: Array<{ re: RegExp; why: string }> = [
  {
    re: /(无摄影机位|没有机位|非拍摄|截屏|截图|屏幕截图)/,
    why: '机位描述显示这不是拍摄画面（截屏/界面）'
  },
  {
    re: /(备忘录|聊天记录|界面|导航栏|状态栏|应用|APP)/i,
    why: '画面元素里有 App 界面（导航栏/备忘录等）'
  },
  { re: /(白底|纯白背景|白背景)/, why: '背景是纯白（排版图特征）' },
  { re: /(表格|清单|列表|排行|编号列表)/, why: '内容是清单/表格/列表式排版' }
]

/**
 * 画面事实 → 「这是纯文字排版图吗」。
 * 事实来自拆解卡的 visual（构图/机位/背景/元素/主体占比），**不看提示词**——
 * 模型看不看得懂画面是它的能力问题，判据必须落在文字事实上。
 * 保守策略：至少两条信号才判为纯文字排版，避免把"白底菜品图"误伤。
 */
export function judgeTextOnlyVisual(
  visual: {
    composition?: string
    camera?: string
    lighting?: string
    colorTone?: string
    layout?: string
    subjectRatio?: string
    elements?: string[]
    textInImage?: string
  } | null
): TextOnlyVerdict {
  if (!visual) return { textOnly: false, reasons: [] }
  const blob = [
    visual.composition,
    visual.camera,
    visual.lighting,
    visual.colorTone,
    visual.layout,
    visual.subjectRatio,
    ...(visual.elements ?? [])
  ]
    .filter(Boolean)
    .join(' ')
  const reasons: string[] = []
  for (const p of TEXT_ONLY_PATTERNS) if (p.re.test(blob)) reasons.push(p.why)
  // 文字占画面比例很高（如「文字内容占整屏 90% 以上」）也是强信号
  const ratio = String(visual.subjectRatio ?? '').match(/(\d{2,3})\s*%/)
  if (ratio && Number(ratio[1]) >= 70)
    reasons.push('主体占比显示文字占了画面 ' + ratio[1] + '% 以上')
  return { textOnly: reasons.length >= 2, reasons }
}
