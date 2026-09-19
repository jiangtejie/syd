/**
 * 营销 AI 工作台配置读取: 生图通道(中转站 /images/generations)。
 * 敏感 Key 走 safeStorage 加封(与 ai.apiKey 同机制)。
 *
 * 注: 原有的联网搜索配置(growth.search.enabled/provider/apiKey)已随搜索链路整体下线删除。
 * 老库里那几个键原样留着(见 index.ts 的 migrateStoredSecrets 注释)，新库不再写。
 *
 * 写入侧说明: **只读这里，写走通用配置 cs:config:set**(设置页表单即 app_config 真源)。
 * 历史上这里另有一套 setGrowthAiConfigField + GrowthAiConfigField 白名单，
 * 但渲染端从无调用者，属于同一配置的第二条写路径，已随 P0 清理删除。
 */

import { getConfig, getConfigBoolean } from '../../../db/repos/config'
import { openSecret } from '../../secrets'

export interface ImageConfig {
  enabled: boolean
  baseUrl: string
  apiKey: string
  model: string
  /** 显式尺寸覆盖；留空 = 由生图策略按平台决定（见 ai/imageStrategy.ts） */
  size: string
  count: number
  /** 默认目标平台：xhs | douyin | moments | group（策略据此选比例与构图） */
  platform: string
  /** 自定义提示词模板库（JSON；留空 = 内置模板） */
  templates: string
  /**
   * 每月生图张数上限（0 = 不限）。
   * 为什么按「张数」而不是金额：接口按张计费但没有单价信息，能算准的只有张数。
   * 超限时由生图策略层拦截并如实报错，不静默失败（见 ai/imageStrategy.ts）。
   */
  monthlyLimit: number
}

export function getImageConfig(): ImageConfig {
  return {
    enabled: getConfigBoolean('growth.image.enabled', false),
    baseUrl: (getConfig('growth.image.baseUrl') ?? '').trim(),
    apiKey: openSecret(getConfig('growth.image.apiKey')),
    model: (getConfig('growth.image.model') ?? 'gptimage2').trim() || 'gptimage2',
    // 尺寸默认留空：以前默认 1024x1024 方图，小红书/抖音的竖版封面全被生成成方图。
    // 现在由 imageStrategy 按平台给（要固定尺寸的用户在设置里填，填了就一律以它为准）。
    size: (getConfig('growth.image.size') ?? '').trim(),
    count: Math.min(Math.max(Number(getConfig('growth.image.count') ?? 2) || 2, 1), 4),
    platform: (getConfig('growth.image.platform') ?? '').trim(),
    templates: getConfig('growth.image.templates') ?? '',
    // 键名沿用 growth.image.monthlyLimit；旧的 monthlyBudget 是纯空壳（无 UI、无消费点），直接改名收口
    monthlyLimit: Math.max(Math.floor(Number(getConfig('growth.image.monthlyLimit')) || 0), 0)
  }
}
