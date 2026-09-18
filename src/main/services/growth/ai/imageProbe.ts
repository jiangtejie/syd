/**
 * 生图通道能力探测。
 *
 * 为什么要有它：中转站的「支持什么」只写在文档里，能不能用取决于**你的密钥属于哪个分组**
 * （uuapi 文档原话：同步 Images 接口并非所有分组都开放，用错分组返回 404 not_found_error）。
 * 于是「能不能按参考图生图」这件事只能实测 —— 与其让策略层去猜、失败再回退，不如一次问清：
 * 有哪些模型、edits 通不通、多图与 mask 收不收、参数怎么给。
 *
 * 分两档：
 *  - meta（**不产生生图调用**）：/v1/models + 一次故意缺参数的 /images/edits 请求。
 *    后者是免费的探针：端点存在但参数不对 → 400；分组没开这个接口 → 404。
 *  - full（**会产生生图调用**）：真发 generations / edits / 多图 / mask，各 1 次。
 *    费用与次数都如实回传（billed 标记），界面要先说清再跑。
 */

import { nativeImage } from 'electron'
import { getImageConfig, type ImageConfig } from './config'
import { generateImages } from './imageProvider'

export type ProbeStatus = 'ok' | 'fail' | 'warn' | 'skip'

export interface ProbeItem {
  id: string
  label: string
  status: ProbeStatus
  detail: string
  /** 该项是否产生了一次真实的生图调用（计费） */
  billed?: boolean
}

export interface ProbeResult {
  ok: boolean
  baseUrl: string
  model: string
  /** /v1/models 里与生图相关的模型（判断「有没有某个模型」以它为准） */
  imageModels: string[]
  items: ProbeItem[]
  /** 实际产生的生图调用次数 */
  billed: number
  error?: string
}

/** 与生图相关的模型名特征（用于从 /v1/models 里挑出候选） */
const IMAGE_MODEL_RE = /(gpt-image|dall|flux|nano.?banana|imagen|seedream|qwen-image|kolors|image)/i

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: 'Bearer ' + apiKey }
}

/** 造一张纯色 PNG 当探测用的参考图：不依赖任何图像库（nativeImage 是 Electron 自带） */
function makeProbePng(size = 512): Buffer {
  const px = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    // 简单的棋盘格：避免纯色被某些服务端当成无效图
    const x = i % size
    const y = Math.floor(i / size)
    const on = (Math.floor(x / 64) + Math.floor(y / 64)) % 2 === 0
    px[i * 4] = on ? 235 : 60
    px[i * 4 + 1] = on ? 120 : 60
    px[i * 4 + 2] = on ? 80 : 60
    px[i * 4 + 3] = 255
  }
  return nativeImage.createFromBitmap(px, { width: size, height: size }).toPNG()
}

async function readText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 400)
  } catch {
    return ''
  }
}

/** ① 可用模型：以它为准判断「有没有某个模型」（文档明确：不要拿模型广场目录当授权名单） */
async function probeModels(cfg: ImageConfig, items: ProbeItem[]): Promise<string[]> {
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/models'
  try {
    const res = await fetch(url, { headers: authHeaders(cfg.apiKey) })
    if (!res.ok) {
      items.push({
        id: 'models',
        label: '可用模型列表 (/v1/models)',
        status: 'warn',
        detail: 'HTTP ' + String(res.status) + ' —— 拿不到列表，无法确认模型可用性'
      })
      return []
    }
    const body = (await res.json()) as { data?: Array<{ id?: string }> }
    const ids = (body.data ?? []).map((m) => String(m.id ?? '')).filter(Boolean)
    const imageModels = ids.filter((id) => IMAGE_MODEL_RE.test(id))
    const hasCurrent = ids.includes(cfg.model)
    items.push({
      id: 'models',
      label: '可用模型列表 (/v1/models)',
      status: hasCurrent ? 'ok' : 'warn',
      detail:
        '共 ' +
        String(ids.length) +
        ' 个模型，其中生图相关 ' +
        String(imageModels.length) +
        ' 个；当前配置的 ' +
        cfg.model +
        (hasCurrent ? ' 在列表里' : ' **不在列表里**（可能分组没开或模型名不对）')
    })
    return imageModels
  } catch (e) {
    items.push({
      id: 'models',
      label: '可用模型列表 (/v1/models)',
      status: 'warn',
      detail: '请求失败: ' + (e instanceof Error ? e.message : String(e))
    })
    return []
  }
}

/**
 * ② edits 端点可达性（**免费**）：故意不带 image 字段。
 * 400 = 端点存在、只是缺参数（分组开放）；404/405 = 分组没开这个接口或端点不存在。
 */
async function probeEditsAccess(cfg: ImageConfig, items: ProbeItem[]): Promise<void> {
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/images/edits'
  try {
    const form = new FormData()
    form.append('model', cfg.model)
    form.append('prompt', 'connectivity probe (no image on purpose)')
    const res = await fetch(url, {
      method: 'POST',
      headers: authHeaders(cfg.apiKey),
      body: form
    })
    const text = await readText(res)
    if (res.status === 404 || res.status === 405 || res.status === 501) {
      items.push({
        id: 'edits-access',
        label: '图生图端点 (/v1/images/edits) 可达性',
        status: 'fail',
        detail:
          'HTTP ' +
          String(res.status) +
          ' —— 你的分组**没有开放同步 Images 接口**（文档：这种情况返回 404 而不是鉴权错误）。' +
          '换分组，或改用异步/批量端点。'
      })
      return
    }
    if (res.status === 400) {
      const aboutImage = /image|missing|required|field|参数/i.test(text)
      items.push({
        id: 'edits-access',
        label: '图生图端点 (/v1/images/edits) 可达性',
        status: 'ok',
        detail:
          'HTTP 400 且提示与参数有关 —— 端点存在（缺 image 被拒），分组开放。原文: ' +
          (text.slice(0, 120) || '(空)') +
          (aboutImage ? '' : '（注意：提示未提到 image，参数名可能不同）')
      })
      return
    }
    if (res.ok) {
      items.push({
        id: 'edits-access',
        label: '图生图端点 (/v1/images/edits) 可达性',
        status: 'warn',
        detail: '没带参考图也返回了 200 —— 端点把请求当成了文生图，需实测确认参考图是否真的生效'
      })
      return
    }
    items.push({
      id: 'edits-access',
      label: '图生图端点 (/v1/images/edits) 可达性',
      status: 'warn',
      detail: 'HTTP ' + String(res.status) + '：' + (text.slice(0, 160) || '(无正文)')
    })
  } catch (e) {
    items.push({
      id: 'edits-access',
      label: '图生图端点 (/v1/images/edits) 可达性',
      status: 'warn',
      detail: '请求失败: ' + (e instanceof Error ? e.message : String(e))
    })
  }
}

/** ③ 文生图实测（计费 1 次）：走既有的 dryRun，不落盘不建资产 */
async function probeGenerations(cfg: ImageConfig, items: ProbeItem[]): Promise<boolean> {
  try {
    const out = await generateImages({
      contentId: 0,
      prompt: 'a simple red circle on white background, flat illustration',
      count: 1,
      size: '1024x1024',
      dryRun: true,
      cfg
    })
    items.push({
      id: 'generations',
      label: '文生图实测 (/v1/images/generations)',
      status: out.images.length > 0 ? 'ok' : 'fail',
      detail: '返回 ' + String(out.images.length) + ' 张图',
      billed: true
    })
    return out.images.length > 0
  } catch (e) {
    items.push({
      id: 'generations',
      label: '文生图实测 (/v1/images/generations)',
      status: 'fail',
      detail: e instanceof Error ? e.message : String(e),
      billed: true
    })
    return false
  }
}

interface EditProbeOutcome {
  ok: boolean
  status: number
  text: string
}

/** 发一次真实的 edits 请求（multipart），由调用方决定带哪些字段 */
async function postEdit(
  cfg: ImageConfig,
  fields: Array<[string, string | Blob, string?]>
): Promise<EditProbeOutcome> {
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/images/edits'
  const form = new FormData()
  form.append('model', cfg.model)
  form.append('prompt', 'keep the composition, change the colors to warm orange')
  form.append('size', '1024x1024')
  for (const [name, value, filename] of fields) {
    if (typeof value === 'string') form.append(name, value)
    else form.append(name, value, filename)
  }
  const res = await fetch(url, { method: 'POST', headers: authHeaders(cfg.apiKey), body: form })
  return { ok: res.ok, status: res.status, text: await readText(res) }
}

/**
 * ④⑤⑥ 真实图生图探测（每次计费 1 次）。
 * 只有 ③④ 通过才继续测多图与 mask —— 省掉注定失败的调用。
 */
async function probeEditsReal(cfg: ImageConfig, items: ProbeItem[]): Promise<void> {
  const png = makeProbePng()
  const ref = (): Blob => new Blob([new Uint8Array(png)], { type: 'image/png' })

  // ④ 单图（multipart image 字段，文档写法）
  let single: EditProbeOutcome
  try {
    single = await postEdit(cfg, [['image', ref(), 'probe.png']])
  } catch (e) {
    items.push({
      id: 'edits',
      label: '图生图实测（单张参考图，multipart image）',
      status: 'fail',
      detail: e instanceof Error ? e.message : String(e),
      billed: true
    })
    return
  }
  items.push({
    id: 'edits',
    label: '图生图实测（单张参考图，multipart image）',
    status: single.ok ? 'ok' : 'fail',
    detail: single.ok
      ? '可用 —— 参考图这条路通了'
      : 'HTTP ' + String(single.status) + '：' + (single.text.slice(0, 200) || '(无正文)'),
    billed: true
  })
  if (!single.ok) return

  // ⑤ 多图：文档只写了 JSON 写法是 images: [...]，multipart 的多图字段形态没写 → 实测
  try {
    const multi = await postEdit(cfg, [
      ['image', ref(), 'a.png'],
      ['image', ref(), 'b.png']
    ])
    items.push({
      id: 'edits-multi',
      label: '多图参考（multipart 重复 image 字段）',
      status: multi.ok ? 'ok' : 'warn',
      detail: multi.ok
        ? '接受多个 image 字段 —— 「模板图 + 自家实拍图」可以直接这么发'
        : 'HTTP ' +
          String(multi.status) +
          '：' +
          (multi.text.slice(0, 160) || '(无正文)') +
          ' → 多图可能要改用 image[] 或 JSON 的 images: []',
      billed: true
    })
  } catch (e) {
    items.push({
      id: 'edits-multi',
      label: '多图参考（multipart 重复 image 字段）',
      status: 'warn',
      detail: '请求失败: ' + (e instanceof Error ? e.message : String(e)),
      billed: true
    })
  }

  // ⑥ mask：局部重绘（透明处 = 要重绘的区域）
  try {
    const masked = await postEdit(cfg, [
      ['image', ref(), 'probe.png'],
      ['mask', ref(), 'mask.png']
    ])
    items.push({
      id: 'edits-mask',
      label: '局部重绘（mask）',
      status: masked.ok ? 'ok' : 'warn',
      detail: masked.ok
        ? '接受 mask —— 可以只换掉原图的某一块（如招牌/logo）'
        : 'HTTP ' + String(masked.status) + '：' + (masked.text.slice(0, 160) || '(无正文)'),
      billed: true
    })
  } catch (e) {
    items.push({
      id: 'edits-mask',
      label: '局部重绘（mask）',
      status: 'warn',
      detail: '请求失败: ' + (e instanceof Error ? e.message : String(e)),
      billed: true
    })
  }
}

/**
 * 跑一次能力探测。
 * @param full true = 含真实出图（会计费）；false = 只做不产生生图调用的探测
 */
export async function probeImageChannel(full: boolean): Promise<ProbeResult> {
  const cfg = getImageConfig()
  const items: ProbeItem[] = []
  const base: ProbeResult = {
    ok: false,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    imageModels: [],
    items,
    billed: 0
  }
  if (!cfg.enabled) return { ...base, error: '生图未启用（先在上面打开开关）' }
  if (!cfg.baseUrl || !cfg.apiKey)
    return { ...base, error: '生图通道未配置（缺 Base URL 或 API Key）' }

  const imageModels = await probeModels(cfg, items)
  await probeEditsAccess(cfg, items)

  if (full) {
    const genOk = await probeGenerations(cfg, items)
    if (genOk) await probeEditsReal(cfg, items)
    else
      items.push({
        id: 'edits',
        label: '图生图实测',
        status: 'skip',
        detail: '文生图都不通，先解决通道问题再测图生图'
      })
  } else {
    items.push({
      id: 'real',
      label: '真实出图探测',
      status: 'skip',
      detail: '未勾选「包含出图实测」（会计费），所以没跑'
    })
  }

  const billed = items.filter((i) => i.billed).length
  return { ...base, ok: items.every((i) => i.status !== 'fail'), imageModels, billed }
}
