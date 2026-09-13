/**
 * 联网搜索 Provider: 博查(bocha) / Tavily / Serper, 统一归一为结果卡数据。
 * 合规: 只检索公开信息; 地址/电话/价格等必须人工确认后才写入门店档案; 图片仅作参考不得直接发布。
 */

import { getSearchConfig, type SearchConfig } from './config'
import { createLogger } from '../../logging'

const log = createLogger('growth-search')

export interface WebResult {
  title: string
  snippet: string
  url: string
  site: string
  publishedAt?: string
}

export interface ImageResult {
  url: string
  thumbUrl: string
  source: string
  width?: number
  height?: number
}

export class SearchSetupError extends Error {}

interface CacheEntry {
  at: number
  web?: WebResult[]
  images?: ImageResult[]
}
const cache = new Map<string, CacheEntry>()
const CACHE_MS = 24 * 3600 * 1000

function cacheKey(kind: string, q: string): string {
  return kind + ':' + q.trim().toLowerCase()
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

async function fetchJson(url: string, init: RequestInit, timeoutMs = 20_000): Promise<unknown> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal })
    const text = await res.text()
    if (!res.ok) throw new Error('搜索失败 HTTP ' + String(res.status) + ': ' + text.slice(0, 200))
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new Error('搜索响应不是 JSON: ' + text.slice(0, 160))
    }
  } finally {
    clearTimeout(timer)
  }
}

// ── 博查 ──
async function bochaWeb(q: string, count: number, key: string): Promise<WebResult[]> {
  const data = (await fetchJson('https://api.bochaai.com/v1/web-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ query: q, count, summary: true, freshness: 'noLimit' })
  })) as { data?: { webPages?: { value?: Array<Record<string, unknown>> } } }
  const list = data.data?.webPages?.value ?? []
  return list.slice(0, count).map((r) => ({
    title: String(r.name ?? ''),
    snippet: String(r.summary ?? r.snippet ?? '').slice(0, 400),
    url: String(r.url ?? ''),
    site: String(r.siteName ?? hostOf(String(r.url ?? ''))),
    publishedAt: r.datePublished ? String(r.datePublished) : undefined
  }))
}

async function bochaImages(q: string, count: number, key: string): Promise<ImageResult[]> {
  const data = (await fetchJson('https://api.bochaai.com/v1/images/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ query: q, count })
  })) as { data?: { value?: Array<Record<string, unknown>> } }
  const list = data.data?.value ?? []
  return list.slice(0, count).map((r) => ({
    url: String(r.contentUrl ?? r.url ?? ''),
    thumbUrl: String(r.thumbnailUrl ?? r.contentUrl ?? ''),
    source: hostOf(String(r.hostPageUrl ?? r.contentUrl ?? '')),
    width: Number(r.width) || undefined,
    height: Number(r.height) || undefined
  }))
}

// ── Tavily ──
async function tavilyWeb(q: string, count: number, key: string): Promise<WebResult[]> {
  const data = (await fetchJson('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: key, query: q, max_results: count, search_depth: 'basic' })
  })) as { results?: Array<Record<string, unknown>> }
  return (data.results ?? []).slice(0, count).map((r) => ({
    title: String(r.title ?? ''),
    snippet: String(r.content ?? '').slice(0, 400),
    url: String(r.url ?? ''),
    site: hostOf(String(r.url ?? '')),
    publishedAt: r.published_date ? String(r.published_date) : undefined
  }))
}

// ── Serper ──
async function serperWeb(q: string, count: number, key: string): Promise<WebResult[]> {
  const data = (await fetchJson('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': key },
    body: JSON.stringify({ q, num: count })
  })) as { organic?: Array<Record<string, unknown>> }
  return (data.organic ?? []).slice(0, count).map((r) => ({
    title: String(r.title ?? ''),
    snippet: String(r.snippet ?? '').slice(0, 400),
    url: String(r.link ?? ''),
    site: hostOf(String(r.link ?? ''))
  }))
}

async function serperImages(q: string, count: number, key: string): Promise<ImageResult[]> {
  const data = (await fetchJson('https://google.serper.dev/images', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': key },
    body: JSON.stringify({ q, num: count })
  })) as { images?: Array<Record<string, unknown>> }
  return (data.images ?? []).slice(0, count).map((r) => ({
    url: String(r.imageUrl ?? ''),
    thumbUrl: String(r.thumbnailUrl ?? r.imageUrl ?? ''),
    source: String(r.source ?? hostOf(String(r.link ?? ''))),
    width: Number(r.imageWidth) || undefined,
    height: Number(r.imageHeight) || undefined
  }))
}

function requireKey(cfg: SearchConfig): string {
  if (!cfg.enabled)
    throw new SearchSetupError('联网搜索未启用: 请到 设置 → AI 助手 → 联网搜索 开启并填写 Key')
  if (!cfg.apiKey) throw new SearchSetupError('联网搜索缺少 API Key(设置 → AI 助手 → 联网搜索)')
  return cfg.apiKey
}

export async function searchWeb(
  query: string,
  opts: { count?: number; cfg?: SearchConfig } = {}
): Promise<WebResult[]> {
  const cfg = opts.cfg ?? getSearchConfig()
  const key = requireKey(cfg)
  const count = Math.min(Math.max(opts.count ?? 6, 1), 10)
  const ck = cacheKey(cfg.provider + ':web', query)
  const hit = cache.get(ck)
  if (hit && Date.now() - hit.at < CACHE_MS && hit.web) return hit.web

  let out: WebResult[] = []
  if (cfg.provider === 'tavily') out = await tavilyWeb(query, count, key)
  else if (cfg.provider === 'serper') out = await serperWeb(query, count, key)
  else out = await bochaWeb(query, count, key)
  cache.set(ck, { at: Date.now(), web: out })
  log.info(
    'web search provider=' + cfg.provider + ' q=' + query.slice(0, 40) + ' n=' + String(out.length)
  )
  return out
}

export async function searchImages(
  query: string,
  opts: { count?: number; cfg?: SearchConfig } = {}
): Promise<ImageResult[]> {
  const cfg = opts.cfg ?? getSearchConfig()
  const key = requireKey(cfg)
  const count = Math.min(Math.max(opts.count ?? 8, 1), 12)
  const ck = cacheKey(cfg.provider + ':img', query)
  const hit = cache.get(ck)
  if (hit && Date.now() - hit.at < CACHE_MS && hit.images) return hit.images

  let out: ImageResult[] = []
  if (cfg.provider === 'serper') out = await serperImages(query, count, key)
  else if (cfg.provider === 'tavily')
    throw new SearchSetupError('Tavily 不支持图片检索: 请改用 bocha 或 serper')
  else out = await bochaImages(query, count, key)
  cache.set(ck, { at: Date.now(), images: out })
  log.info(
    'image search provider=' +
      cfg.provider +
      ' q=' +
      query.slice(0, 40) +
      ' n=' +
      String(out.length)
  )
  return out
}
