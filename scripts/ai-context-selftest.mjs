import { buildSync } from 'esbuild'
import { createRequire } from 'module'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

/**
 * 上下文窗口与长会话压缩自检（纯函数）。
 *
 * 钉住的是「同一套算法复制两份、缺陷只长在其中一份上」这条真实故障链：
 *  ① 裁剪上限曾低于压缩触发阈值（工作台 24k < 36k），中间区间**静默丢上下文**，
 *     界面没有任何标记 —— 阈值现在由预算派生，结构上不可能再配反；
 *  ② 压缩必须真的发生，而不是等不到触发就先被裁剪吃掉；
 *  ③ 摘要带水位：每行最多被摘要一次，长会话成本不随轮次线性叠加；
 *  ④ 确实丢了行时必须回传 dropped，让调用方能说出来（不许静默）。
 */

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'dsh-ai-context-'))

let failed = 0
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  ✔ ' : '  ✖ ') + label + (extra ? ' — ' + extra : ''))
  if (!cond) failed++
}

/** 造 n 行历史，每行 chars 字，id 从 1 递增 */
const rows = (n, chars, role = 'user') =>
  Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    role: i % 2 === 0 ? role : 'assistant',
    kind: 'text',
    content: 'x'.repeat(chars)
  }))

try {
  const bundle = join(work, 'contextWindow.cjs')
  buildSync({
    entryPoints: [join(root, 'src/main/services/ai/contextWindow.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle
  })
  const {
    planContextWindow,
    trimByBudget,
    buildSummaryInput,
    normalizeSummary,
    mergeSummary,
    compressThresholdChars,
    MAX_MSG_CHARS,
    MAX_ROWS,
    SUMMARY_MAX_CHARS,
    SUMMARY_PER_ROW_CHARS,
    SUMMARY_INPUT_CHARS,
    COMPRESS_BUDGET_RATIO
  } = require(bundle)

  console.log('阈值与预算的关系（历史故障：24k 上限 < 36k 触发阈值）：')
  ok(COMPRESS_BUDGET_RATIO < 1, '比例严格小于 1（等于/大于 1 就会退化成先裁剪后压缩）')
  ok(
    compressThresholdChars(24_000) === 18_000,
    '工作台 24k 预算 → 阈值 18k',
    `实得 ${compressThresholdChars(24_000)}`
  )
  ok(
    compressThresholdChars(48_000) === 36_000,
    '助手 48k 预算 → 阈值 36k（与它原阈值一致，行为不变）'
  )
  for (const b of [1000, 8000, 24_000, 36_000, 48_000, 200_000]) {
    ok(compressThresholdChars(b) < b, `预算 ${b} 的阈值严格小于预算`)
  }
  ok(compressThresholdChars(0) === 0 && compressThresholdChars(-5) === 0, '脏预算不产生负阈值')

  console.log('24k~36k 区间不再静默丢上下文：')
  {
    // 30k 字符：旧口径下 > 24k 上限会被裁剪，却 < 36k 阈值等不到压缩
    const hist = rows(30, 1000)
    const plan = planContextWindow(hist, { budgetChars: 24_000 })
    ok(plan.totalChars === 30_000, '总量识别为 30k')
    ok(plan.shouldCompress, '30k 落在旧「静默丢」区间 → 现在必须触发压缩')
    ok(plan.toSummarize.length === 15, '旧段一半进摘要', `实得 ${plan.toSummarize.length}`)
    ok(plan.tail.length === 15, '新段一半保留')
    const { kept, dropped } = trimByBudget(
      plan.tail.map((r) => ({ role: r.role, content: r.content })),
      24_000
    )
    ok(dropped === 0 && kept.length === 15, '压缩后尾段放得进预算，零丢弃', `dropped=${dropped}`)
  }
  {
    // 恰好等于阈值不压缩，超过才压缩（边界）
    const at = planContextWindow(rows(24, 750), { budgetChars: 24_000 })
    ok(at.totalChars === 18_000 && !at.shouldCompress, '恰好等于阈值 → 不压缩')
    const over = planContextWindow(rows(24, 751), { budgetChars: 24_000 })
    ok(over.shouldCompress, '超过阈值 1 字符 → 压缩')
  }
  {
    const few = planContextWindow(rows(10, 5000), { budgetChars: 24_000 })
    ok(!few.shouldCompress, '行数不足 24 且未超行数上限 → 不压缩（短会话零 LLM 成本）')
  }

  console.log('超行数上限同样触发压缩（短消息长会话）：')
  {
    const many = rows(50, 10)
    const plan = planContextWindow(many, { budgetChars: 24_000 })
    ok(
      plan.totalChars === 500 && plan.shouldCompress,
      '50 行 × 10 字：字符远低于阈值，但超 40 行上限 → 压缩'
    )
    ok(plan.tail.length === 25, '保留最近一半 25 行')
    const { dropped } = trimByBudget(
      plan.tail.map((r) => ({ role: r.role, content: r.content })),
      24_000
    )
    ok(dropped === 0, '不再按条数静默丢行')
  }

  console.log('水位：已摘要的行不重复喂模型')
  {
    const hist = rows(40, 1000)
    const p1 = planContextWindow(hist, { budgetChars: 24_000, uptoId: 0 })
    ok(
      p1.shouldCompress && p1.nextUptoId === 20,
      '首轮摘要前 20 行，水位推到 20',
      ` uptoId=${p1.nextUptoId}`
    )
    ok(
      p1.toSummarize.every((r) => r.id <= 20),
      '摘要输入只含水位之前的行'
    )
    // 第二轮：同样的历史 + 已落库的水位 → 不该再摘要一次
    const p2 = planContextWindow(hist, { budgetChars: 24_000, uptoId: p1.nextUptoId })
    ok(!p2.shouldCompress, '第二轮剩 20 行 20k：低于阈值 → 不再调模型')
    ok(p2.toSummarize.length === 0 && p2.summaryInput === '', '第二轮摘要输入为空')
    ok(p2.tail.length === 20 && p2.tail.every((r) => r.id > 20), '第二轮上下文只含水位之后的行')
    ok(p2.nextUptoId === 20, '无新摘要时水位不动')
  }

  console.log('长会话成本：每行最多被摘要一次（不随轮次线性叠加）')
  {
    let hist = rows(30, 1000)
    let uptoId = 0
    const summarized = new Map()
    let llmCalls = 0
    for (let turn = 0; turn < 40; turn++) {
      const plan = planContextWindow(hist, { budgetChars: 24_000, uptoId })
      if (plan.shouldCompress && plan.toSummarize.length > 0) {
        llmCalls++
        for (const r of plan.toSummarize) summarized.set(r.id, (summarized.get(r.id) ?? 0) + 1)
        uptoId = plan.nextUptoId
      }
      // 每轮新增 2 行
      const base = hist.length
      hist = hist.concat(
        Array.from({ length: 2 }, (_, i) => ({
          id: base + i + 1,
          role: i % 2 === 0 ? 'user' : 'assistant',
          kind: 'text',
          content: 'y'.repeat(1000)
        }))
      )
    }
    const repeated = [...summarized.entries()].filter(([, n]) => n > 1)
    ok(repeated.length === 0, '没有任何一行被摘要两次', `重复行 ${repeated.length}`)
    ok(summarized.size <= hist.length, '摘要过的行数不超过总行数')
    // 旧实现：超阈值后每轮都摘要一次 → 40 轮里绝大多数轮都要调模型
    ok(llmCalls < 40, `40 轮里摘要调用 ${llmCalls} 次（旧实现接近每轮一次）`)
    console.log(
      `    · 总行数 ${hist.length}，摘要覆盖 ${summarized.size} 行，LLM 摘要调用 ${llmCalls} 次`
    )
  }

  console.log('裁剪：单条截断 / 总量预算 / dropped 可见')
  {
    const long = [{ role: 'user', content: 'z'.repeat(MAX_MSG_CHARS + 500) }]
    const { kept } = trimByBudget(long, 24_000)
    ok(
      kept[0].content.length === MAX_MSG_CHARS + '\n…(超长已截断)'.length,
      '单条超长按 6000 截断并加尾注'
    )
    ok(kept[0].content.endsWith('…(超长已截断)'), '截断尾注在')
    ok(long[0].content.length === MAX_MSG_CHARS + 500, '不修改入参（纯函数）')
  }
  {
    const turns = rows(10, 3000).map((r) => ({ role: r.role, content: r.content }))
    const { kept, dropped } = trimByBudget(turns, 9000)
    ok(
      kept.length === 3 && dropped === 7,
      '预算 9k / 每条 3k → 留 3 条丢 7 条',
      `kept=${kept.length} dropped=${dropped}`
    )
    ok(kept[kept.length - 1].content === turns[turns.length - 1].content, '保留的是最新几条')
  }
  {
    const turns = rows(5, 100).map((r) => ({ role: r.role, content: r.content }))
    const { kept, dropped } = trimByBudget(turns, 24_000)
    ok(kept.length === 5 && dropped === 0, '预算内零丢弃')
  }
  {
    const turns = rows(MAX_ROWS + 8, 10).map((r) => ({ role: r.role, content: r.content }))
    const { kept, dropped } = trimByBudget(turns, 24_000)
    ok(kept.length === MAX_ROWS && dropped === 8, '条数上限也计入 dropped（不许静默）')
  }
  ok(trimByBudget([], 24_000).dropped === 0, '空历史不报错')

  console.log('摘要输入与输出口径：')
  {
    const input = buildSummaryInput(rows(3, 1000))
    ok(input.split('\n').length === 3, '每行一条')
    ok(input.startsWith('用户: '), '首行贴用户标签')
    ok(input.includes('助手: '), '助手行贴助手标签')
    ok(
      input.split('\n')[0].length === '用户: '.length + SUMMARY_PER_ROW_CHARS + 1,
      '每行按 400 字截断并加省略号'
    )
  }
  {
    const input = buildSummaryInput(rows(200, 1000))
    ok(input.length <= SUMMARY_INPUT_CHARS, '总量不超过 24k', `实得 ${input.length}`)
    ok(input.endsWith('…'), '末行是被截断的较新行（从尾部保留）')
    ok(
      input.split('\n').length < 200,
      '较旧的行被裁掉而不是全塞进去',
      `实得 ${input.split('\n').length} 行`
    )
    // 用可区分的内容验证「保留的是较新的旧段」
    const marked = Array.from({ length: 200 }, (_, i) => ({
      id: i + 1,
      role: 'user',
      kind: 'text',
      content: `ROW${i + 1}|` + 'x'.repeat(1000)
    }))
    const mi = buildSummaryInput(marked)
    ok(mi.includes('ROW200|'), '最新一行在摘要输入里')
    ok(!mi.includes('ROW1|'), '最旧一行已被总量上限裁掉')
  }
  {
    const custom = buildSummaryInput(
      [{ id: 1, role: 'user', kind: 'tool_result', content: 'abc' }],
      (r) => (r.kind === 'tool_result' ? '工具结果' : '助手')
    )
    ok(custom === '工具结果: abc', '标签函数可覆盖（助手侧要区分工具结果/错误）')
  }
  ok(buildSummaryInput([]) === '', '空输入 → 空串')
  ok(
    normalizeSummary('') === null &&
      normalizeSummary(null) === null &&
      normalizeSummary(undefined) === null,
    '空摘要归一为 null'
  )
  ok(normalizeSummary('  hi  ') === 'hi', '去空白')
  ok(normalizeSummary('q'.repeat(3000)).length === SUMMARY_MAX_CHARS, '摘要输出上限 1400')
  ok(mergeSummary(null, 'b') === 'b' && mergeSummary('a', null) === 'a', '单侧为空时取另一侧')
  ok(mergeSummary('a', 'b') === 'a\nb', '旧摘要在前、新摘要在后')
  {
    const merged = mergeSummary('a'.repeat(1000), 'b'.repeat(1000))
    ok(merged.length <= SUMMARY_MAX_CHARS, '合并后仍受 1400 上限')
    ok(merged.endsWith('b'.repeat(100)), '超限保留较新的部分')
    ok(merged.includes('更早的对话已多轮压缩'), '超限明确标注早期已被压缩')
  }

  console.log('脏输入兜底：')
  {
    const p = planContextWindow([], { budgetChars: 24_000 })
    ok(!p.shouldCompress && p.tail.length === 0 && p.nextUptoId === 0, '空历史安全')
    const neg = planContextWindow(rows(5, 100), { budgetChars: 24_000, uptoId: -1 })
    ok(neg.tail.length === 5, '负水位视为 0')
    const nan = planContextWindow(rows(5, 100), { budgetChars: 24_000, uptoId: NaN })
    ok(nan.tail.length === 5, 'NaN 水位视为 0')
  }

  rmSync(work, { recursive: true, force: true })
} catch (e) {
  console.error('自检异常：', e)
  failed++
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 条失败`)
process.exit(failed === 0 ? 0 : 1)
