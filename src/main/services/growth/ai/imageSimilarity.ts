/**
 * 图生图的「产物到底改没改」检测（纯函数，零依赖，可离线自检）。
 *
 * 为什么需要：图生图有一种很隐蔽的失败 —— 接口 200、返回一张图，但那张图**跟参考图几乎一样**
 * （模型没接受改写指令，或中转站直接把输入回传了）。界面上一切正常，用户以为「爆改」成功了，
 * 实际拿到的是别人的原图。这条链路必须能自己发现并说出来。
 *
 * 做法：两边都缩到 16×16 灰度，比平均绝对差（MAD，0~255）。差异极小 = 疑似原图回传。
 * 注意这是**启发式**：我们本来就要求模型「保持构图」，所以 MAD 不会很大；
 * 判据只用来抓「几乎一模一样」这一种情况，措辞上也要说「疑似」而不是断言。
 */

/** 签名边长（16×16 = 256 个采样点，够用且几乎不耗时） */
export const SIG_SIZE = 16
/** 疑似原图回传的阈值：MAD < 4/255 ≈ 1.6% 的差异，正常改写不可能这么小 */
export const ECHO_MAD_THRESHOLD = 4

/** 两个同长度灰度签名之间的平均绝对差 */
export function meanAbsDiff(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  if (n === 0) return Number.NaN
  let sum = 0
  for (let i = 0; i < n; i++) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0))
  return sum / n
}

/**
 * 疑似「原图被原样回传」：两张图几乎一致。
 * 取不到画面（签名为空）或长度不一致时返回 false —— 宁可不报，也不要凭空调警报。
 */
export function looksLikeEcho(a: number[], b: number[]): boolean {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return false
  const mad = meanAbsDiff(a, b)
  return Number.isFinite(mad) && mad < ECHO_MAD_THRESHOLD
}
