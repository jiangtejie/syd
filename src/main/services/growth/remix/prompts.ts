/**
 * AI 拆解 / 爆改 提示词与 JSON 解析(纯函数, 可独立单测)。
 * 注意: 不使用模板围栏正则, JSON 提取靠大括号平衡扫描(容忍模型输出杂文)。
 */

import type { GrowthContentItem, GrowthRemixStyle } from '../../../../shared/growth'

export const STYLE_LABEL: Record<GrowthRemixStyle, string> = {
  tanDian: '探店种草风(突出体验感/画面感, 适合小红书)',
  shangXin: '门店上新官宣(新品/新店开业, 干脆有力)',
  cuXiao: '优惠促单风(套餐/团购引导, 突出划算与时限提示)',
  renShe: '老板/门店人设朋友圈(真实、松弛、像人话)'
}

/** 把素材内容转成可读文本块(喂给 LLM) */
export function describeItem(item: GrowthContentItem): string {
  const head: string[] = []
  head.push(
    '平台: ' +
      (item.origin === 'xhs' ? '小红书' : item.origin === 'douyin' ? '抖音' : item.origin || '未知')
  )
  head.push(
    '类型: ' + (item.kind === 'video' ? '视频' : item.kind === 'image_text' ? '图文' : '未知')
  )
  if (item.title) head.push('标题: ' + item.title)
  if (item.text) head.push('正文/文案: ' + item.text.slice(0, 1500))
  if (item.authorName) head.push('作者: ' + item.authorName)
  const inter = item.interactions
  head.push(
    '互动: 赞' +
      String(inter.likes) +
      ' 藏' +
      String(inter.collects) +
      ' 评' +
      String(inter.comments) +
      ' 转' +
      String(inter.shares)
  )
  return head.join('\n')
}

/** 拆解请求: 学它为什么火(结构启发, 不抄原文) */
export function buildAnalyzePrompt(item: GrowthContentItem): { system: string; user: string } {
  const system = [
    '你是餐饮私域运营的内容教练。用户给你一条同行的爆款内容, 你的任务是「拆结构, 不抄内容」,',
    '帮运营看懂它为什么有效, 为后续品牌化改写提供素材。',
    '只输出一个 JSON 对象(不要 Markdown 代码块, 不要其他文字), 结构如下:',
    '{',
    '  "hook": "开头钩子(前3秒/首图吸引人的点, 一句话)",',
    '  "structure": "正文骨架: 痛点→方案→证据→促单 的分段描述",',
    '  "sellingPoints": ["卖点1", "卖点2"],',
    '  "titlePatterns": ["这条标题可复用的写法套路, 如: 人群点名+悬念"],',
    '  "commentTopics": ["评论区用户关心/追问的高频主题"],',
    '  "whyWorks": "它为什么能火(情绪/共鸣/信息差/氛围感等), 两句话"',
    '}'
  ].join('\n')
  return { system, user: describeItem(item) }
}

/** 改写请求: 结构启发 → 全新品牌文案(餐饮门店) */
export function buildRemixPrompt(input: {
  item: GrowthContentItem
  decompText: string
  style: GrowthRemixStyle
}): { system: string; user: string } {
  const system = [
    '你是一名餐饮门店的内容运营。基于给定的「爆款拆解」创作全新文案:',
    '规则(务必遵守):',
    '1. 只借鉴结构与情绪, 不允许复述、仿写原句; 所有文字必须原创且符合本店实际;',
    '2. 不虚构门店事实(菜品/价格/活动/地址等一律用占位符如【菜品】【套餐】【店名】, 由运营替换);',
    '3. 普通食品禁止功效宣称(不能说治病/减肥/保健), 不用绝对化用语(最/第一/唯一);',
    '4. 风格: ' + STYLE_LABEL[input.style] + ';',
    '5. 只输出一个 JSON 对象(不要 Markdown 代码块), 结构:',
    '{ "titles": ["标题1", "标题2", "标题3", "标题4", "标题5"], "copies": ["正文A(80-150字)", "正文B(80-150字, 不同侧重)"] }'
  ].join('\n')
  const user = [
    '——爆款拆解——',
    input.decompText,
    '',
    '——参考素材原文(只许看结构与感觉, 禁止照抄)——',
    describeItem(input.item)
  ].join('\n')
  return { system, user }
}

/** 从模型输出中稳健提取 JSON: 容忍围栏/前后杂文, 大括号平衡扫描 */
export function parseModelJson(raw: string): Record<string, unknown> | null {
  if (!raw) return null
  const text = raw.trim()
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as Record<string, unknown>
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/** 解析爆改结果并容错归一 */
export function normalizeRemixResult(parsed: Record<string, unknown> | null): {
  titles: string[]
  copies: string[]
} {
  const titles: string[] = []
  const copies: string[] = []
  if (parsed) {
    const t = parsed['titles']
    const c = parsed['copies']
    if (Array.isArray(t)) {
      for (const x of t) {
        const s = typeof x === 'string' ? x.trim() : ''
        if (s && titles.length < 8) titles.push(s)
      }
    }
    if (Array.isArray(c)) {
      for (const x of c) {
        const s = typeof x === 'string' ? x.trim() : ''
        if (s && copies.length < 4) copies.push(s)
      }
    }
  }
  return { titles, copies }
}
