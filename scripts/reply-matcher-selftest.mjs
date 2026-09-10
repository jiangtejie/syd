import { buildSync } from 'esbuild'
import { createRequire } from 'module'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

/**
 * 话术判定自检（纯函数，不碰库、不发消息）。
 *
 * 用**真实群里的原话**当夹具（问到货、发票、对账单、退款、投诉、图片、纯应答…），
 * 断言「该回的按对话术回、该转人工的绝不自动回、该忽略的别打扰」。
 * 改话术模板或匹配规则后先跑它，再去看值班页的影子记录。
 */

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'dsh-matcher-'))

let failed = 0
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  ✔ ' : '  ✖ ') + label + (extra ? ' — ' + extra : ''))
  if (!cond) failed++
}

try {
  const bundle = join(work, 'matcher.cjs')
  buildSync({
    entryPoints: [join(root, 'src/main/services/agent/matcher.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle
  })
  const bundle2 = join(work, 'starters.cjs')
  buildSync({
    entryPoints: [join(root, 'src/main/services/agent/starters.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle2
  })
  const { matchReply, renderTemplate } = require(bundle)
  const { STARTER_SCRIPTS } = require(bundle2)

  // 把模板转成匹配器要的形状（id/priority/enabled 等）
  const scripts = STARTER_SCRIPTS.map((s, i) => ({
    id: i + 1,
    accountWxid: '',
    intent: s.intent,
    title: s.title ?? s.intent,
    patterns: s.patterns,
    replyText: s.replyText,
    riskLevel: s.riskLevel ?? 'A',
    priority: s.priority ?? 100,
    enabled: true,
    source: 'starter',
    hitCount: 0
  }))
  const hit = (text, extra = {}) => matchReply({ text, ...extra }, scripts)

  console.log('真实原话 → 判定：')
  const cases = [
    ['现在孜然粉到货了没', 'reply', '到货时间'],
    ['鸡爪今天到不了吗？', 'reply', '到货时间'],
    ['@菜菜 发票开了吗', 'reply', '发票进度'],
    ['@菜菜 你好，发票记得哦', 'reply', '发票进度'],
    ['对账单一起发我哦', 'reply', '对账单/单据'],
    ['这个单子还没收到？', 'reply', '对账单/单据'],
    ['党总，这两个品缺货了预计一周内到仓，其余的有货先走吗？', 'reply', '缺货先发'],
    ['常温的所有货就先压单，等周一货到仓了在一起发吧', 'reply', '缺货先发'],
    ['颜总，看了物流，要明天才送货哦', 'reply', '物流查询'],
    ['明天安排一个拖挂车', 'reply', '排车安排'],
    ['垮丝', 'llm', ''],
    ['这个价格太贵了，能不能便宜点', 'reply', '价格优惠']
  ]
  for (const [text, action, intent] of cases) {
    const r = hit(text)
    const got = r.action === 'reply' || r.action === 'handoff' ? r.script.intent : r.action
    ok(r.action === action && (intent === '' || got === intent), `${text.slice(0, 22)} → ${action}${intent ? ' / ' + intent : ''}`, r.action + (r.script ? ' / ' + r.script.intent : ''))
  }

  console.log('\n高风险绝不自动回：')
  for (const text of ['多付的4袋钱走流程退款吧', '你们这质量太差了，我要投诉', '合同什么时候签', '这个货坏了要赔']) {
    const r = hit(text)
    ok(r.action === 'handoff', `${text.slice(0, 16)} → 转人工（不自动回）`, r.action + (r.script ? ' / ' + r.script.intent : ''))
  }

  console.log('\n不打扰：')
  ok(hit('好的').action === 'skip', '「好的」= 纯应答，不介入')
  ok(hit('收到，我去安排').action === 'skip', '「收到，我去安排」= 纯应答变体，不介入')
  ok(hit('发票请查收').action === 'skip', '「发票请查收」= 事务性通知，不介入')
  ok(hit('今日发货明细如下，请查收').action === 'skip', '发货明细通知，不介入')
  ok(hit('[图片]', { nonText: true }).action === 'skip', '图片消息：一期看不懂 → 不自动回（记入转过人工）')
  ok(hit('在吗', { fromTeam: true }).action === 'skip', '我方/同事已发言 → 退让')
  ok(hit('   ').action === 'skip', '空消息不介入')

  console.log('\n变量与边界：')
  ok(renderTemplate('{{客户名}}好，{{群名}}已收到', { 客户名: '颜总', 群名: 'A 群' }) === '颜总好，A 群已收到', '模板变量替换')
  ok(renderTemplate('{{未知}}', {}) === '{{未知}}', '未知变量原样保留（影子复盘能看到模板缺变量）')
  const badRe = matchReply(
    { text: '订单 12345 什么时候发' },
    [{ id: 1, accountWxid: '', intent: '坏正则', title: '坏正则', patterns: [{ type: 're', value: '[' }], replyText: 'x', riskLevel: 'A', priority: 1, enabled: true, source: 't', hitCount: 0 }]
  )
  ok(badRe.action === 'llm', '写错的正则不会崩，退化为 LLM 兜底')
  const disabled = matchReply(
    { text: '到货了没' },
    [{ id: 1, accountWxid: '', intent: '关掉的', title: '关掉的', patterns: [{ type: 'kw', value: '到货了没' }], replyText: 'x', riskLevel: 'A', priority: 1, enabled: false, source: 't', hitCount: 0 }]
  )
  ok(disabled.action === 'llm', '停用的话术不参与命中')
  const prio = matchReply(
    { text: '到货了没' },
    [
      { id: 1, accountWxid: '', intent: '低优先', title: '低优先', patterns: [{ type: 'kw', value: '到货' }], replyText: 'x', riskLevel: 'A', priority: 900, enabled: true, source: 't', hitCount: 0 },
      { id: 2, accountWxid: '', intent: '高优先', title: '高优先', patterns: [{ type: 'kw', value: '到货了没' }], replyText: 'y', riskLevel: 'A', priority: 5, enabled: true, source: 't', hitCount: 0 }
    ]
  )
  ok(prio.action === 'reply' && prio.script.intent === '高优先', '多条命中时取优先级小的')
} finally {
  try {
    rmSync(work, { recursive: true, force: true })
  } catch {
    /* Windows 偶发占用：自检结果不受影响 */
  }
}

console.log(failed === 0 ? '\n全部通过 ✅' : '\n' + failed + ' 项失败 ❌')
process.exit(failed === 0 ? 0 : 1)
