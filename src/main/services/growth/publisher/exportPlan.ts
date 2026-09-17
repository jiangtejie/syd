import { blockingHits, complianceHitsOf, type ComplianceHit } from '../remix/compliance'

/**
 * 发布包导出的**纯决策层**（零 IO，可离线自检）。
 *
 * 从 exporter.ts 拆出来的原因：这里的每条规则错一次就是**法律风险**（盗图 / AIGC 未标识 /
 * 极限词原样发布），必须能脱离 electron 与文件系统单独断言。
 *
 * 三条规则：
 * 1. **以产出为准**：某条产出自带图时只用它自己的图。产出的图是「为这条文案选/生成」的，
 *    而素材名下那批图里混着从平台扒下来的竞品原图；
 * 2. **来源=参考（usage=ref）的素材图一律不打包**：那是别人的作品，随文案发出去就是侵权
 *    （入库时已经把这类素材标成 ref 了，只是导出从来没读过这个字段）；
 * 3. **AI 生成图必须可识别**：文件名加前缀、文案头部加声明 —— 既是《人工智能生成合成内容
 *    标识办法》的要求，也是避免把示意图当实拍发出去。
 */

export const AI_IMAGE_PREFIX = 'AI生成示意图_'

export interface ContentImageRef {
  kind: string
  relPath: string
}

export interface OutputImageRef {
  /** 产出图来源：gen（AI 生成）/ store（门店实拍）/ search（联网检索）/ '' */
  source: string
  note: string
  relPath: string
}

export interface PlannedFile {
  /** 素材缓存里的相对路径（复制源） */
  relPath: string
  /** 包内文件名 */
  name: string
  isAi: boolean
  /** 联网检索来的图：版权未确认，包里单独提示 */
  fromSearch: boolean
}

export interface ExportPlan {
  files: PlannedFile[]
  /** 因「来源=参考」被扣下的图片张数（文案里如实告知，别让用户以为导全了） */
  withheldRef: number
  /** 是否用到了产出自带图（false = 退回了素材图） */
  usedOutputAssets: boolean
}

/** 是不是 AI 生成的图：产出资产的 source 为 gen，或备注里写了「AI 生成」 */
export function isAiImage(source: string, note: string): boolean {
  return (source ?? '').trim().toLowerCase() === 'gen' || /AI\s*生成/.test(note ?? '')
}

/** 是不是联网检索来的图（版权需人工确认） */
export function isSearchImage(source: string, note: string): boolean {
  return (source ?? '').trim().toLowerCase() === 'search' || /联网检索/.test(note ?? '')
}

export function planExportImages(input: {
  /** 素材自身的用途：ref（参考/他人）/ own（自产）/ licensed（已授权） */
  contentUsage: string
  contentImages: ContentImageRef[]
  outputImages: OutputImageRef[]
}): ExportPlan {
  const outputImages = (input.outputImages ?? []).filter((a) => !!a.relPath)
  const usedOutputAssets = outputImages.length > 0
  const usage = (input.contentUsage ?? '').trim()
  const contentImages = (input.contentImages ?? []).filter((a) => !!a.relPath)

  let picked: Array<{ relPath: string; isAi: boolean; fromSearch: boolean }> = []
  let withheldRef = 0
  if (usedOutputAssets) {
    picked = outputImages.map((a) => ({
      relPath: a.relPath,
      isAi: isAiImage(a.source, a.note),
      fromSearch: isSearchImage(a.source, a.note)
    }))
  } else if (usage === 'ref') {
    // 参考素材：只借它的结构与选题，绝不把原图打进发布包
    withheldRef = contentImages.length
  } else {
    picked = contentImages.map((a) => ({ relPath: a.relPath, isAi: false, fromSearch: false }))
  }

  const seen = new Set<string>()
  const files: PlannedFile[] = []
  let seq = 1
  for (const img of picked) {
    if (seen.has(img.relPath)) continue
    seen.add(img.relPath)
    const dot = img.relPath.lastIndexOf('.')
    const ext = dot >= 0 ? img.relPath.slice(dot) : '.jpg'
    const base = seq === 1 ? '封面' : '图' + String(seq)
    files.push({
      relPath: img.relPath,
      name: (img.isAi ? AI_IMAGE_PREFIX : '') + base + ext,
      isAi: img.isAi,
      fromSearch: img.fromSearch
    })
    seq += 1
  }
  return { files, withheldRef, usedOutputAssets }
}

export type ExportGate =
  { ok: true; warnings: ComplianceHit[] } | { ok: false; error: string; hits: ComplianceHit[] }

/**
 * 导出前的合规硬门禁：只拦 block 级（广告法绝对化用语 / 普通食品功效宣称）。
 * warn 级（背书、贬低同行、促销紧迫、平台导流词）不阻断，随包附提示。
 */
export function exportGate(texts: string[]): ExportGate {
  const all = complianceHitsOf(texts)
  const blocked = blockingHits(texts)
  if (blocked.length > 0) {
    const detail = blocked
      .map((h) => `${h.label}${h.term ? '（命中：' + h.term + '）' : ''}`)
      .join('；')
    return {
      ok: false,
      error: `合规门禁拦截，已停止导出：${detail}。请改写后再导出（这类表述属于违法风险，不是风格建议）`,
      hits: blocked
    }
  }
  return { ok: true, warnings: all.filter((h) => h.level === 'warn') }
}

/** 发布包文案头部的合规块：AIGC 声明 + 来源 + 扣下的图 + 需人工确认的提示 */
export function complianceBanner(input: {
  warnings: ComplianceHit[]
  withheldRef: number
  aiCount: number
  searchCount: number
  origin: string
  authorName: string
  link: string
}): string {
  const lines: string[] = []
  lines.push('> **发布前必读**')
  lines.push('>')
  lines.push(
    '> - 本包由工具生成，**发布前请人工核对**：占位符【店名/菜品/价格/活动】需替换为门店真实信息。'
  )
  if (input.aiCount > 0) {
    lines.push(
      '> - 含 ' +
        String(input.aiCount) +
        ' 张 **AI 生成示意图**（文件名以「' +
        AI_IMAGE_PREFIX +
        '」开头）：请勿当作门店实拍发布，并保留 AI 生成标识。'
    )
  }
  if (input.searchCount > 0) {
    lines.push(
      '> - 含 ' +
        String(input.searchCount) +
        ' 张 **联网检索图**：版权未确认，商用前请自行确认授权。'
    )
  }
  if (input.withheldRef > 0) {
    lines.push(
      '> - 已按用途门禁**扣下 ' +
        String(input.withheldRef) +
        ' 张来源为「参考」的图片**（他人素材，原图不得随文案发布）。'
    )
  }
  const src = [input.origin, input.authorName, input.link].filter(Boolean).join(' · ')
  if (src) lines.push('> - 选题参考来源：' + src + '（仅作参考，发布物需原创化）')
  if (input.warnings.length > 0) {
    lines.push('> - 合规提示（不阻断导出，但请确认）：')
    for (const w of input.warnings) {
      lines.push('>   - ' + w.label + (w.term ? '（命中：' + w.term + '）' : ''))
    }
  }
  lines.push('')
  return lines.join('\n')
}
