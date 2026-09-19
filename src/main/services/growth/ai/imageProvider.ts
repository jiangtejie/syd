/**
 * 生图 Provider: OpenAI 兼容 /images/generations(中转站 gptimage2 等)，以及图生图 /images/edits。
 * 产出统一落盘到 growth 媒体库并登记 growth_asset(挂在任务素材下), 返回可直接展示的候选。
 */

import { nativeImage } from 'electron'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { getGrowthMediaDir } from '../../paths'
import { getAssetById, insertAsset } from '../../../db/repos/growthRepo'
import { getImageConfig, type ImageConfig } from './config'
import { composeFinalPrompt, parseSize } from './imageStrategy'
import { SIG_SIZE } from './imageSimilarity'
import { createLogger } from '../../logging'

const log = createLogger('growth-image')

export interface GeneratedImage {
  assetId: number
  relPath: string
  note: string
  revisedPrompt: string
}

export class ImageSetupError extends Error {}

function extFromMime(mime: string): string {
  if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpg'
  if (mime.includes('webp')) return '.webp'
  return '.png'
}

/**
 * 图片落盘 + 登记资产。
 * 导出给封面合成复用（那条链路不调用生图接口，但产物同样要进 growth_asset 才能被产出引用）。
 */
export async function storeImageBuffer(
  buf: Buffer,
  mime: string,
  contentId: number,
  prompt: string,
  /** 请求尺寸：落库成宽高，事后才能判断「出来的图是不是按平台比例」 */
  size: string,
  /** 来源标记（gen:image = AI 生图，会计入月度张数；cover:composite = 本地合成的封面，不计） */
  sourceMark = 'gen:image'
): Promise<GeneratedImage> {
  const ext = extFromMime(mime)
  const sha = createHash('sha1').update(buf).digest('hex')
  const sub = sha.slice(0, 2)
  const relPath = sub + '/' + sha + ext
  await mkdir(join(getGrowthMediaDir(), sub), { recursive: true })
  await writeFile(join(getGrowthMediaDir(), relPath), buf)
  const wh = parseSize(size)
  const assetId = insertAsset({
    contentId,
    kind: 'image',
    mime,
    size: buf.length,
    // 记下来：生成图以前 width/height/sha256 全是空，连「这张是不是竖版」都无从判断
    sha256: sha,
    width: wh?.width ?? 0,
    height: wh?.height ?? 0,
    relPath,
    sourceMark
  })
  // 注：本函数是通用落盘，note 由调用方决定（生图/封面合成口径不同），这里只给 AI 图默认话术
  return {
    assetId,
    relPath,
    note: sourceMark === 'gen:image' ? 'AI 生成示意图(非实拍)' : '',
    revisedPrompt: prompt
  }
}

/** 参考图（图生图）：原爆款图 / 门店实拍图，用来生成"同构但原创"的图 */
export interface ImageReference {
  data: Buffer
  mime: string
  filename: string
}

export interface GenerateResult {
  images: GeneratedImage[]
  /** 是否真的走了参考图（/images/edits）。false = 通道不支持，已回退纯文本 */
  usedReference: boolean
  /** 实际随请求发出的参考图张数（0 = 纯文本） */
  referenceCount: number
  /** 回退原因（要如实告诉用户，不能悄悄降级） */
  warning?: string
}

/**
 * 生成图片。
 * @param contentId 归属素材(资产表要求 content_id, 生成图挂到任务素材下)
 * @param references 参考图（可空，**可多张**）。给了就先试 /images/edits（图生图），
 *   通道不支持时回退纯文本并在 warning 里说明 —— 静默降级会让用户以为"参考图生效了"。
 *   多张时的语义约定：**按数组顺序编号**，prompt 里必须写清"图1 是什么、图2 是什么"
 *   （实测该通道接受 multipart 重复 image 字段；不写清模型会把两张图混在一起）。
 */
export async function generateImages(input: {
  contentId: number
  prompt: string
  /** 负向词：接口层不保证都支持 negative_prompt，统一拼进 prompt 文本最通用 */
  negative?: string
  count?: number
  size?: string
  references?: ImageReference[] | null
  /**
   * 连通性测试：只要"接口能不能出图"这个结论，**不落盘、不建资产**。
   * 此前测试图会挂在"素材仓库第一条素材"名下（既污染真实素材，又得先入库一条素材才能测），
   * 而连通性测试本来就不该产生业务数据。
   */
  dryRun?: boolean
  cfg?: ImageConfig
  /** 用户取消信号（点「停止」）：与内建 120s 超时串起来，任一触发都中断请求 */
  signal?: AbortSignal
}): Promise<GenerateResult> {
  const cfg = input.cfg ?? getImageConfig()
  if (!cfg.enabled)
    throw new ImageSetupError('生图未启用: 请到 设置 → AI 助手 → 生图模型 配置并开启')
  if (!cfg.baseUrl || !cfg.apiKey)
    throw new ImageSetupError(
      '生图通道未配置: 请填写 Base URL 与 API Key(设置 → AI 助手 → 生图模型)'
    )

  const apiBase = cfg.baseUrl.replace(/\/+$/, '')
  const url = apiBase + '/images/generations'
  const editUrl = apiBase + '/images/edits'
  const n = Math.min(Math.max(input.count ?? cfg.count, 1), 4)
  const prompt = composeFinalPrompt(input.prompt, input.negative ?? '')
  // 尺寸兜底：策略层一定会给；这里再兜一次，避免把空串/脏值传给接口
  const size = input.size && parseSize(input.size) ? input.size : cfg.size || '1024x1024'
  const body = {
    model: cfg.model,
    prompt,
    n,
    size,
    response_format: 'b64_json'
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 120_000)
  // 用户的取消要能立刻打断这次请求：两个来源共用一个控制器，谁先来都算
  const onAbort = (): void => ctrl.abort()
  if (input.signal?.aborted) onAbort()
  else input.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const doRequest = async (
      payload: Record<string, unknown>
    ): Promise<{ ok: boolean; status: number; text: string }> => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
        body: JSON.stringify(payload),
        signal: ctrl.signal
      })
      return { ok: res.ok, status: res.status, text: await res.text() }
    }

    /** 图生图：multipart POST /images/edits（OpenAI 兼容写法的通例） */
    const refs = input.references ?? []
    const doEdit = async (): Promise<{ ok: boolean; status: number; text: string }> => {
      const form = new FormData()
      form.append('model', cfg.model)
      form.append('prompt', prompt)
      form.append('n', String(n))
      form.append('size', size)
      // 多张参考图 = 重复 image 字段（已在 uuapi 实测通过）
      for (const ref of refs) {
        form.append('image', new Blob([new Uint8Array(ref.data)], { type: ref.mime }), ref.filename)
      }
      const res = await fetch(editUrl, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + cfg.apiKey },
        body: form,
        signal: ctrl.signal
      })
      return { ok: res.ok, status: res.status, text: await res.text() }
    }

    let r: { ok: boolean; status: number; text: string }
    let usedReference = false
    let warning: string | undefined
    if (refs.length > 0) {
      const edit = await doEdit()
      if (edit.ok) {
        r = edit
        usedReference = true
      } else if (isEditUnsupported(edit)) {
        // 通道不支持图生图：回退纯文本，但**必须说出来**
        warning =
          '该生图通道不支持参考图(/images/edits 返回 ' +
          String(edit.status) +
          ')，本次按纯文本生成(画面结构与原图无关)。'
        r = await doRequest(body)
      } else {
        r = edit
      }
    } else {
      r = await doRequest(body)
    }
    // 兼容: 部分中转站/新模型不接受 response_format 参数 → 去掉后重试一次
    if (
      !r.ok &&
      !usedReference &&
      /response_format|unknown parameter|unrecognized|unsupported/i.test(r.text)
    ) {
      const fallback: Record<string, unknown> = { ...body }
      delete fallback.response_format
      r = await doRequest(fallback)
    }
    const text = r.text
    if (!r.ok) {
      throw new Error('生图失败 HTTP ' + String(r.status) + ': ' + text.slice(0, 300))
    }
    let parsed: { data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }> }
    try {
      parsed = JSON.parse(text) as typeof parsed
    } catch {
      throw new Error('生图响应不是 JSON: ' + text.slice(0, 200))
    }
    const items = Array.isArray(parsed.data) ? parsed.data : []
    if (items.length === 0) throw new Error('生图接口未返回图片')

    const out: GeneratedImage[] = []
    for (const item of items) {
      if (item.b64_json) {
        const buf = Buffer.from(item.b64_json, 'base64')
        // dryRun：只确认"接口回了图"，不写磁盘、不建资产
        if (input.dryRun) {
          out.push({ assetId: 0, relPath: '', note: '连通性测试(未落盘)', revisedPrompt: prompt })
        } else {
          out.push(
            await storeImageBuffer(
              buf,
              'image/png',
              input.contentId,
              item.revised_prompt ?? prompt,
              size
            )
          )
        }
      } else if (item.url) {
        if (input.dryRun) {
          out.push({ assetId: 0, relPath: '', note: '连通性测试(未落盘)', revisedPrompt: prompt })
          continue
        }
        const r = await fetch(item.url, { signal: ctrl.signal })
        if (!r.ok) continue
        const mime = (r.headers.get('content-type') || 'image/png').split(';')[0]
        out.push(
          await storeImageBuffer(
            Buffer.from(await r.arrayBuffer()),
            mime,
            input.contentId,
            prompt,
            size
          )
        )
      }
    }
    if (out.length === 0) throw new Error('生图结果为空(接口可能未返回 b64_json/url)')
    if (usedReference)
      log.info('used ' + String(refs.length) + ' reference image(s) (/images/edits)')
    log.info(
      'generated ' +
        String(out.length) +
        ' image(s) model=' +
        cfg.model +
        ' size=' +
        size +
        (input.dryRun ? ' (dryRun)' : '')
    )
    return { images: out, usedReference, referenceCount: usedReference ? refs.length : 0, warning }
  } catch (e) {
    // 用户取消不要伪装成「生图失败 HTTP …」：上层据此回「已取消」，而不是让模型去排查通道
    if (input.signal?.aborted) throw new Error('已取消（用户停止了本轮生成）')
    throw e
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * 取一张图的 16×16 灰度签名（用于「产物是不是被原样回传」的比对）。
 * 解码与缩放交给 Electron 自带能力，不引图像库；失败返回空数组（调用方据此不报警）。
 */
export function graySignature(png: Buffer): number[] {
  try {
    const img = nativeImage.createFromBuffer(png)
    if (img.isEmpty()) return []
    const small = img.resize({ width: SIG_SIZE, height: SIG_SIZE, quality: 'good' })
    const bmp = small.toBitmap() // BGRA
    const out: number[] = []
    for (let i = 0; i < SIG_SIZE * SIG_SIZE; i++) {
      const b = bmp[i * 4] ?? 0
      const g = bmp[i * 4 + 1] ?? 0
      const r = bmp[i * 4 + 2] ?? 0
      // 亮度加权（人眼对绿最敏感）：只要量级正确即可，不追求色彩准确
      out.push(0.299 * r + 0.587 * g + 0.114 * b)
    }
    return out
  } catch {
    return []
  }
}

/**
 * 从素材库取一张图作为参考图（图生图用）。
 * 只读本地已落盘的资产 —— 平台直链（extra.remoteMedia）没有下载过就拿不到，返回 null 让调用方如实说明。
 */
export async function loadImageReference(assetId: number): Promise<ImageReference | null> {
  const asset = getAssetById(assetId)
  if (!asset || !asset.relPath) return null
  try {
    const data = await readFile(join(getGrowthMediaDir(), asset.relPath))
    return {
      data,
      mime: asset.mime || 'image/png',
      filename: basename(asset.relPath) || 'reference.png'
    }
  } catch {
    return null
  }
}

/**
 * 这个失败像不像"通道不支持图生图"？只有这一类才该回退纯文本。
 * 判据：接口没有该端点（404/405）或明确说 edits/image 参数不支持。
 * 其余失败（比如 400 提示 prompt 有问题、429 限流）原样抛出 —— 否则用户会以为
 * "参考图不生效"，实际是别的原因。
 */
function isEditUnsupported(r: { ok: boolean; status: number; text: string }): boolean {
  if (r.status === 404 || r.status === 405 || r.status === 501) return true
  return /images\/edits|unknown (url|endpoint|route)|not found|unsupported|does not (exist|support)|invalid url/i.test(
    r.text
  )
}

/**
 * 连通性测试(发一次最小请求, 1 张图)。
 * dryRun：不落盘、不建资产、不占月度张数 —— 测试不该往业务数据里塞东西。
 */
export async function testImageChannel(): Promise<{ ok: boolean; error?: string }> {
  try {
    await generateImages({
      contentId: 0,
      prompt: 'a simple red circle on white background',
      count: 1,
      size: '1024x1024',
      dryRun: true
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
