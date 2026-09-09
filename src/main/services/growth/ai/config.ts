/**
 * 营销 AI 工作台配置: 生图模型(gptimage2 中转站) / 联网搜索 provider。
 * 敏感 Key 走 safeStorage 加封(与 ai.apiKey 同机制)。
 */

import { getConfig, getConfigBoolean, setConfig } from '../../../db/repos/config'
import { openSecret, sealSecret } from '../../secrets'

export interface ImageConfig {
  enabled: boolean
  baseUrl: string
  apiKey: string
  model: string
  size: string
  count: number
  monthlyBudget: number
}

export interface SearchConfig {
  enabled: boolean
  provider: string
  apiKey: string
}

export function getImageConfig(): ImageConfig {
  return {
    enabled: getConfigBoolean('growth.image.enabled', false),
    baseUrl: (getConfig('growth.image.baseUrl') ?? '').trim(),
    apiKey: openSecret(getConfig('growth.image.apiKey')),
    model: (getConfig('growth.image.model') ?? 'gptimage2').trim() || 'gptimage2',
    size: (getConfig('growth.image.size') ?? '1024x1024').trim(),
    count: Math.min(Math.max(Number(getConfig('growth.image.count') ?? 2) || 2, 1), 4),
    monthlyBudget: Math.max(Number(getConfig('growth.image.monthlyBudget') ?? 0) || 0, 0)
  }
}

export function getSearchConfig(): SearchConfig {
  return {
    enabled: getConfigBoolean('growth.search.enabled', false),
    provider: (getConfig('growth.search.provider') ?? 'bocha').trim(),
    apiKey: openSecret(getConfig('growth.search.apiKey'))
  }
}

export type GrowthAiConfigField =
  | 'imageEnabled'
  | 'imageBaseUrl'
  | 'imageApiKey'
  | 'imageModel'
  | 'imageSize'
  | 'imageCount'
  | 'imageBudget'
  | 'searchEnabled'
  | 'searchProvider'
  | 'searchApiKey'

export function setGrowthAiConfigField(field: GrowthAiConfigField, value: string): void {
  const v = value ?? ''
  switch (field) {
    case 'imageEnabled':
      setConfig('growth.image.enabled', v === '1' || v === 'true' ? '1' : '0')
      return
    case 'imageBaseUrl':
      setConfig('growth.image.baseUrl', v.trim().slice(0, 300))
      return
    case 'imageApiKey':
      setConfig('growth.image.apiKey', sealSecret(v.trim()))
      return
    case 'imageModel':
      setConfig('growth.image.model', v.trim().slice(0, 100) || 'gptimage2')
      return
    case 'imageSize':
      setConfig('growth.image.size', v.trim().slice(0, 32) || '1024x1024')
      return
    case 'imageCount':
      setConfig('growth.image.count', String(Math.min(Math.max(Number(v) || 2, 1), 4)))
      return
    case 'imageBudget':
      setConfig('growth.image.monthlyBudget', String(Math.max(Number(v) || 0, 0)))
      return
    case 'searchEnabled':
      setConfig('growth.search.enabled', v === '1' || v === 'true' ? '1' : '0')
      return
    case 'searchProvider':
      setConfig('growth.search.provider', v.trim().slice(0, 32) || 'bocha')
      return
    case 'searchApiKey':
      setConfig('growth.search.apiKey', sealSecret(v.trim()))
      return
  }
}
