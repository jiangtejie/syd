import { buildSync } from 'esbuild'
import { createRequire } from 'module'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

/**
 * 输出预算策略自检（纯函数）。
 *
 * 钉住的是「思考型模型把预算吃光」这条真实故障链：
 *  ① 思考型模型第一轮就必须给够（否则必然白跑一次，用户白等十几秒）；
 *  ② 用户显式配的预算说了算（否则用户会以为设置没生效）；
 *  ③ 上一轮预算用完后必须按倍数放大，且不许超过硬上限；
 *  ④ 「预算被吃光」和「通道/结构异常」要能区分（后者放大预算也没用，不该重试）。
 */

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'dsh-ai-budget-'))

let failed = 0
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  ✔ ' : '  ✖ ') + label + (extra ? ' — ' + extra : ''))
  if (!cond) failed++
}

try {
  const bundle = join(work, 'outputBudget.cjs')
  buildSync({
    entryPoints: [join(root, 'src/main/services/ai/outputBudget.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle
  })
  const {
    planOutputBudget,
    looksLikeReasoningModel,
    looksBudgetExhausted,
    budgetExhaustedMessage,
    REASONING_FLOOR,
    BUDGET_CAP
  } = require(bundle)

  console.log('思考型模型识别：')
  ok(looksLikeReasoningModel('deepseek-reasoner'), 'deepseek-reasoner 认出')
  ok(looksLikeReasoningModel('deepseek-r1-0528'), 'deepseek-r1 认出')
  ok(looksLikeReasoningModel('qwq-32b') && looksLikeReasoningModel('glm-z1-air'), 'qwq / glm-z 认出')
  ok(looksLikeReasoningModel('o3-mini') && looksLikeReasoningModel('gpt-5-thinking'), 'o 系列 / thinking 认出')
  ok(looksLikeReasoningModel('qwen3-max-think'), '带 -think 后缀的认出')
  ok(!looksLikeReasoningModel('gpt-4o-mini') && !looksLikeReasoningModel('deepseek-chat'), '普通模型不误判')
  ok(!looksLikeReasoningModel('') && !looksLikeReasoningModel(undefined), '空模型名不误判')

  console.log('预算规划：')
  const plain = planOutputBudget({ fallback: 2400, model: 'gpt-4o-mini' })
  ok(plain.maxTokens === 2400 && plain.reason === 'fallback', '普通模型：按调用点默认值', String(plain.maxTokens))
  const reasoner = planOutputBudget({ fallback: 2400, model: 'deepseek-reasoner' })
  ok(
    reasoner.maxTokens === REASONING_FLOOR && reasoner.reason === 'reasoning-boost',
    '思考型模型：第一轮就抬到下限（不白跑一次）',
    String(reasoner.maxTokens)
  )
  const already = planOutputBudget({ fallback: 16000, model: 'deepseek-reasoner' })
  ok(already.maxTokens === 16000, '默认值已经够高就不再动它', String(already.maxTokens))
  const configured = planOutputBudget({ fallback: 2400, configured: 3000, model: 'deepseek-reasoner' })
  ok(
    configured.maxTokens === 3000 && configured.reason === 'configured',
    '用户显式配了预算 → 听用户的（不擅自加码）',
    String(configured.maxTokens)
  )
  ok(planOutputBudget({ fallback: 2400, configured: 0, model: 'x' }).maxTokens === 2400, '配 0 = 未配置')
  ok(planOutputBudget({ fallback: 2400, configured: '不是数字', model: 'x' }).maxTokens === 2400, '配了脏值 → 回落默认')

  console.log('失败后放大：')
  const a1 = planOutputBudget({ fallback: 2400, model: 'gpt-4o', attempt: 1 })
  ok(a1.maxTokens === 9600 && a1.reason === 'escalated', '第二轮按 4 倍放大', String(a1.maxTokens))
  const a2 = planOutputBudget({ fallback: 2400, model: 'gpt-4o', attempt: 2 })
  ok(a2.maxTokens === 32768, '继续放大但撞硬上限', String(a2.maxTokens))
  ok(a2.maxTokens === BUDGET_CAP, '上限就是 BUDGET_CAP')
  const boostedEsc = planOutputBudget({ fallback: 2400, model: 'deepseek-reasoner', attempt: 1 })
  ok(boostedEsc.maxTokens === 32768, '思考型模型从 8192 起步放大直接到上限', String(boostedEsc.maxTokens))
  const capped = planOutputBudget({ fallback: 2400, configured: 999999, model: 'x' })
  ok(capped.maxTokens === BUDGET_CAP, '用户填了超大值也夹到硬上限', String(capped.maxTokens))
  ok(
    planOutputBudget({ fallback: 2400, configured: -5, model: 'x' }).maxTokens === 2400,
    '负数配置视为未配置'
  )
  ok(
    planOutputBudget({ fallback: 2400, model: 'x', attempt: 99 }).maxTokens <= BUDGET_CAP,
    'attempt 再离谱也不越上限'
  )
  ok(planOutputBudget({ fallback: 1, model: 'x' }).maxTokens >= 64, '兜底不会给出荒唐的小预算')

  console.log('是不是「预算被思考吃光」：')
  ok(
    looksBudgetExhausted({ hasText: false, reasoningChars: 1200 }) === true,
    '有正文缺失 + 有思考过程 → 判定为预算被吃光'
  )
  ok(
    looksBudgetExhausted({ hasText: false, reasoningTokens: 5000 }) === true,
    '接口报了思考 tokens 也算'
  )
  ok(
    looksBudgetExhausted({ hasText: false, finishReason: 'length' }) === true,
    '接口明说被长度截断也算'
  )
  ok(
    looksBudgetExhausted({ hasText: false }) === false,
    '既没思考也没截断 → 不是预算问题（不该重试）'
  )
  ok(
    looksBudgetExhausted({ hasText: true, reasoningChars: 999 }) === false,
    '有正文就不算失败（哪怕思考很长）'
  )

  console.log('诊断话术（要能指导下一步，而不是只说失败）：')
  const msg = budgetExhaustedMessage({
    maxTokens: 2400,
    outputTokens: 2405,
    reasoningTokens: 2300,
    reasoningChars: 1800
  })
  ok(msg.includes('思考') && msg.includes('没有写出正文'), '说清是思考吃光了预算')
  ok(msg.includes('2405') && msg.includes('2300') && msg.includes('2400'), '带上真实数字', msg.slice(0, 40))
  ok(msg.includes('设置') && msg.includes('输出预算'), '指出下一步去哪改什么')
  const msg2 = budgetExhaustedMessage({ maxTokens: 3000, reasoningChars: 900 })
  ok(msg2.includes('900') && !msg2.includes('tokens，其中思考 0'), '只有字数时报字数', msg2.slice(0, 30))
} finally {
  try {
    rmSync(work, { recursive: true, force: true })
  } catch {
    /* Windows 偶发占用 */
  }
}

console.log(failed === 0 ? '\n全部通过 ✅' : '\n' + failed + ' 项失败 ❌')
process.exit(failed === 0 ? 0 : 1)
