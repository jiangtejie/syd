/**
 * AI 拆解 提示词与 JSON 解析(纯函数, 可独立单测)。
 * 注意: 不使用模板围栏正则, JSON 提取靠大括号平衡扫描(容忍模型输出杂文)。
 *
 * 历史说明: 这里原有「一键爆改」的 `buildRemixPrompt`/`normalizeRemixResult`/`STYLE_LABEL`。
 * 该链路已由「营销 → AI 工作台」的工具承接(growth_rewrite_title/copy), 且无调用方, 故删除;
 * 需要恢复见 git 历史。
 */

import type { GrowthContentItem } from '../../../../shared/growth'

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
