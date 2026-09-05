/**
 * 模型通道错误 → 用户可读描述(工作台 / 对话 / 建议共用)。
 * SDK 网关错误多为英文原文且夹带 JSON,直接上屏不友好;
 * 规则命中时给出中文头(丢原文噪声),未命中原样返回,保证不丢失排查信息。
 */

const RULES: Array<{ re: RegExp; label: string }> = [
  {
    re: /401|unauthori[sz]ed|authentication|invalid.{0,8}(api.?key|key)|(api.?key|key).{0,8}invalid/i,
    label: 'AI 通道鉴权失败(API 密钥无效或已过期)'
  },
  { re: /403|forbidden/i, label: 'AI 通道拒绝访问(403,可能无权限或账号被限制)' },
  { re: /429|rate\s?limit|too many requests/i, label: 'AI 通道限流(请求过于频繁,请稍后重试)' },
  { re: /insufficient|balance|quota|billing|payment/i, label: 'AI 通道余额或额度不足' },
  {
    re: /model.{0,20}not.{0,20}found|does not exist|no such model/i,
    label: '模型不存在或通道不支持该模型(请检查模型名配置)'
  },
  { re: /404/i, label: 'AI 通道地址或资源不存在(404,请检查 Base URL 与模型名)' },
  { re: /timeout|timed\s?out|ETIMEDOUT/i, label: 'AI 请求超时(网络慢或通道繁忙,可稍后重试)' },
  {
    re: /ECONNREFUSED|ECONNRESET|ENOTFOUND|socket\s?hang|fetch failed|failed to fetch|network error|networkerror|502|503|bad gateway|overloaded/i,
    label: 'AI 通道网络不可达或服务暂不可用(请检查网络与 Base URL 后重试)'
  },
  {
    re: /content.{0,6}(filter|policy)|safety system/i,
    label: '内容被 AI 通道安全策略拦截,请调整措辞'
  }
]

/** 命中规则返回中文描述;未命中返回空串(调用方回退原文) */
export function describeModelError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? '')
  const text = raw.trim()
  if (!text) return ''
  for (const { re, label } of RULES) {
    if (re.test(text)) return label
  }
  return ''
}
