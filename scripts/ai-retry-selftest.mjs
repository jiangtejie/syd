import { buildSync } from 'esbuild'
import { createRequire } from 'module'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

/**
 * AI 通道「重试 / 超时 / 并发」判定自检（纯函数 + 闸门行为）。
 *
 * 钉住的是一条安全性质与一条成本性质：
 *  ① **用户主动取消绝不重试** —— 否则「点了停止又发出去」会变成真的；
 *  ② 只有限流/网关/网络/超时值得重试，4xx（Key 错、模型名错、参数错）重试纯属浪费额度；
 *  ③ 并发闸门要真的限住，且某个任务抛错不能把队列卡死。
 */

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'dsh-ai-retry-'))

let failed = 0
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  ✔ ' : '  ✖ ') + label + (extra ? ' — ' + extra : ''))
  if (!cond) failed++
}

try {
  const b1 = join(work, 'retryPolicy.cjs')
  buildSync({
    entryPoints: [join(root, 'src/main/services/ai/retryPolicy.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: b1
  })
  const b2 = join(work, 'limit.cjs')
  buildSync({
    entryPoints: [join(root, 'src/main/services/ai/limit.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: b2
  })
  const R = require(b1)
  const { createLimiter } = require(b2)

  console.log('哪些 HTTP 状态值得重试：')
  for (const s of [408, 429, 500, 502, 503, 504, 599]) ok(R.isRetryableStatus(s) === true, 'HTTP ' + s + ' 可重试')
  for (const s of [400, 401, 403, 404, 422, 200]) ok(R.isRetryableStatus(s) === false, 'HTTP ' + s + ' 不重试')

  console.log('错误分类：')
  const abortErr = new Error('x'); abortErr.name = 'AbortError'
  ok(R.classifyError(abortErr) === 'aborted', 'AbortError → aborted')
  ok(R.classifyError(new Error('用户已取消')) === 'aborted', '中文「用户已取消」→ aborted（本仓库的中断原因）')
  ok(R.classifyError(new Error('AI 请求超时')) === 'timeout', '中文「超时」→ timeout')
  ok(R.classifyError(new Error('LLM 流式响应空闲超过 45s，判定挂死')) === 'timeout', '「判定挂死」→ timeout')
  ok(R.classifyError(new Error('fetch failed')) === 'network', 'fetch failed → network')
  ok(R.classifyError(new Error('LLM 调用失败 HTTP 429: rate limit')) === 'http', 'HTTP 错误 → http')
  ok(R.classifyError(new Error('模型返回为空')) === 'other', '其它 → other')

  console.log('值不值得再试（安全性质）：')
  ok(R.isRetryableError(new Error('用户已取消')) === false, '★ 用户取消绝不重试')
  ok(R.isRetryableError(abortErr) === false, '★ AbortError 绝不重试')
  ok(R.isRetryableError(R.aiHttpError(429, 'rate limit')) === true, '限流(429) → 重试')
  ok(R.isRetryableError(R.aiHttpError(503, 'busy')) === true, '网关 503 → 重试')
  ok(R.isRetryableError(R.aiHttpError(401, 'bad key')) === false, 'Key 错(401) 不重试（重试也还是错）')
  ok(R.isRetryableError(R.aiHttpError(400, 'bad request')) === false, '参数错(400) 不重试')
  ok(R.isRetryableError(new Error('fetch failed')) === true, '网络错误 → 重试')
  ok(R.isRetryableError(new Error('LLM 流式响应空闲超过 45s，判定挂死')) === true, '流挂死 → 重试')

  console.log('退避：')
  const fixed = () => 0.5
  const b1st = R.backoffMs(1, undefined, fixed)
  const b2nd = R.backoffMs(2, undefined, fixed)
  const b3rd = R.backoffMs(3, undefined, fixed)
  ok(b1st > 0 && b2nd > b1st && b3rd > b2nd, '指数递增', [b1st, b2nd, b3rd].join(' < '))
  ok(R.backoffMs(9, undefined, fixed) <= R.MAX_BACKOFF_MS, '有上限，不会无限等待', String(R.backoffMs(9, undefined, fixed)))
  ok(R.backoffMs(1, 5, fixed) === 5000, '尊重 Retry-After（5s → 5000ms）')
  ok(R.backoffMs(1, 999, fixed) === R.MAX_BACKOFF_MS, 'Retry-After 过大也被上限截住')
  ok(R.backoffMs(1, undefined, () => 0) !== R.backoffMs(1, undefined, () => 1), '带抖动（避免多任务同频重试）')
  const e429 = R.aiHttpError(429, 'rate limit', 7)
  ok(R.retryAfterOf(e429) === 7, 'Retry-After 挂在错误对象上', String(R.retryAfterOf(e429)))
  ok(R.retryAfterOf(new Error('x')) === undefined, '没有时不乱给值')

  console.log('失败 Top 的短码：')
  ok(R.errorCodeOf(R.aiHttpError(429, 'rate limit')) === 'HTTP 429', 'HTTP 错取状态码')
  ok(R.errorCodeOf(new Error('fetch failed')).length <= 40, '其它取截断后的原因')
  ok(R.errorCodeOf(new Error('带\n换行\n的原因')).indexOf('\n') < 0, '换行被压平（否则表格会串行）')

  console.log('并发闸门：')
  const lim = createLimiter(2)
  let active = 0
  let peak = 0
  let done = 0
  const task = () => lim.run(async () => {
    active += 1; peak = Math.max(peak, active)
    await new Promise((r) => setTimeout(r, 12))
    active -= 1; done += 1
    return true
  })
  await Promise.all([task(), task(), task(), task(), task()])
  ok(done === 5, '全部任务都跑完（排队的不会被丢）', String(done))
  ok(peak <= 2, '并发峰值不超过上限', 'peak=' + peak)
  ok(lim.stats().active === 0 && lim.stats().queued === 0, '跑完闸门归零', JSON.stringify(lim.stats()))

  let rejected = false
  await lim.run(async () => { throw new Error('boom') }).catch(() => { rejected = true })
  ok(rejected === true, '任务抛错会 reject 给调用方')
  const after = await lim.run(async () => 'still-works')
  ok(after === 'still-works', '★ 抛错不会把闸门卡死（否则后续 AI 调用永久排队）')
  ok(lim.stats().active === 0, '抛错后 active 也归零')
} finally {
  try { rmSync(work, { recursive: true, force: true }) } catch { /* Windows 偶发占用 */ }
}

console.log(failed === 0 ? '\n全部通过 ✅' : '\n' + failed + ' 项失败 ❌')
process.exit(failed === 0 ? 0 : 1)
