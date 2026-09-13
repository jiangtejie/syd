/**
 * 生图 Provider: OpenAI 兼容 /images/generations(中转站 gptimage2 等)。
 * 产出统一落盘到 growth 媒体库并登记 growth_asset(挂在任务素材下), 返回可直接展示的候选。
 */

import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getGrowthMediaDir } from '../../paths'
import { insertAsset } from '../../../db/repos/growthRepo'
import { getImageConfig, type ImageConfig } from './config'
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

async function storeBuffer(
  buf: Buffer,
  mime: string,
  contentId: number,
  prompt: string
): Promise<GeneratedImage> {
  const ext = extFromMime(mime)
  const sha = createHash('sha1').update(buf).digest('hex')
  const sub = sha.slice(0, 2)
  const relPath = sub + '/' + sha + ext
  await mkdir(join(getGrowthMediaDir(), sub), { recursive: true })
  await writeFile(join(getGrowthMediaDir(), relPath), buf)
  const assetId = insertAsset({
    contentId,
    kind: 'image',
    mime,
    size: buf.length,
    relPath,
    sourceMark: 'gen:image'
  })
  return { assetId, relPath, note: 'AI 生成示意图(非实拍)', revisedPrompt: prompt }
}

/**
 * 生成图片。
 * @param contentId 归属素材(资产表要求 content_id, 生成图挂到任务素材下)
 */
export async function generateImages(input: {
  contentId: number
  prompt: string
  count?: number
  size?: string
  cfg?: ImageConfig
}): Promise<GeneratedImage[]> {
  const cfg = input.cfg ?? getImageConfig()
  if (!cfg.enabled)
    throw new ImageSetupError('生图未启用: 请到 设置 → AI 助手 → 生图模型 配置并开启')
  if (!cfg.baseUrl || !cfg.apiKey)
    throw new ImageSetupError(
      '生图通道未配置: 请填写 Base URL 与 API Key(设置 → AI 助手 → 生图模型)'
    )

  const url = cfg.baseUrl.replace(/\/+$/, '') + '/images/generations'
  const n = Math.min(Math.max(input.count ?? cfg.count, 1), 4)
  const body = {
    model: cfg.model,
    prompt: input.prompt,
    n,
    size: input.size ?? cfg.size,
    response_format: 'b64_json'
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 120_000)
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

    let r = await doRequest(body)
    // 兼容: 部分中转站/新模型不接受 response_format 参数 → 去掉后重试一次
    if (!r.ok && /response_format|unknown parameter|unrecognized|unsupported/i.test(r.text)) {
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
        out.push(
          await storeBuffer(buf, 'image/png', input.contentId, item.revised_prompt ?? input.prompt)
        )
      } else if (item.url) {
        const r = await fetch(item.url, { signal: ctrl.signal })
        if (!r.ok) continue
        const mime = (r.headers.get('content-type') || 'image/png').split(';')[0]
        out.push(
          await storeBuffer(Buffer.from(await r.arrayBuffer()), mime, input.contentId, input.prompt)
        )
      }
    }
    if (out.length === 0) throw new Error('生图结果为空(接口可能未返回 b64_json/url)')
    log.info('generated ' + String(out.length) + ' image(s) model=' + cfg.model)
    return out
  } finally {
    clearTimeout(timer)
  }
}

/** 连通性测试(发一次最小请求, 1 张图) */
export async function testImageChannel(
  contentId: number
): Promise<{ ok: boolean; error?: string }> {
  try {
    await generateImages({
      contentId,
      prompt: 'a simple red circle on white background',
      count: 1,
      size: '1024x1024'
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
