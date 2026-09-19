import { buildSync } from 'esbuild'
import { createRequire } from 'module'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

/**
 * AI 拆解提示词契约自检（纯函数，不联网、不碰库）。
 *
 * 为什么必须有：拆解卡的输出结构是**下游的输入契约** ——
 *  ① structure（hook/structure/sellingPoints/...）喂给爆改对话；
 *  ② visual（构图/机位/光线/色调/留白/主体占比/元素/图上文字）喂给图生图的【保持】清单。
 * 少一个字段不会报错：表现只是「生图改出来不是同一个版式」，而且没人能看出为什么。
 * 这里把「system 里必须出现哪些键」钉死，改提示词时漏字段会立刻红。
 */

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'dsh-growth-analyze-'))
/** Markdown 围栏字符（用码点拼出来，免得这个文件里出现三连反引号） */
const FENCE = String.fromCharCode(96).repeat(3)

let failed = 0
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  ✔ ' : '  ✖ ') + label + (extra ? ' — ' + extra : ''))
  if (!cond) failed++
}

try {
  const bundle = join(work, 'prompts.cjs')
  buildSync({
    entryPoints: [join(root, 'src/main/services/growth/remix/prompts.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle
  })
  const { buildAnalyzePrompt, parseModelJson, describeItem } = require(bundle)

  const item = {
    id: 1,
    origin: 'xhs',
    kind: 'image_text',
    title: '成都人自己的火锅',
    text: '人均68，鲜切黄牛肉…',
    authorName: '某火锅店',
    interactions: { likes: 1200, collects: 300, comments: 40, shares: 12 }
  }

  console.log('拆解请求：')
  const { system, user } = buildAnalyzePrompt(item)
  const KEYS = ['hook', 'structure', 'sellingPoints', 'titlePatterns', 'commentTopics', 'whyWorks']
  ok(
    KEYS.every((k) => system.includes('"' + k + '"')),
    '文字维度 6 个键都在 system 里',
    KEYS.filter((k) => !system.includes('"' + k + '"')).join(',') || '齐全'
  )
  const VISUAL = [
    'composition',
    'camera',
    'lighting',
    'colorTone',
    'layout',
    'subjectRatio',
    'elements',
    'textInImage'
  ]
  ok(
    VISUAL.every((k) => system.includes('"' + k + '"')),
    '视觉维度 8 个键都在 system 里（图生图的【保持】靠它们）',
    VISUAL.filter((k) => !system.includes('"' + k + '"')).join(',') || '齐全'
  )
  ok(system.includes('"visual"'), 'visual 是独立子对象（与 structure 分开存库）')
  ok(/不要编造|真的看得见/.test(system), '明确禁止编造看不见的画面细节')

  /**
   * 有没有附图是两种 prompt —— 这一条是真实事故的补丁：
   * 拆解请求此前**从不附参考图**（provider.complete 只收文本），却要求模型输出构图/机位/光线；
   * 模型照着"看不清就留空"办，visual_json 永远是空的（素材 #9 是 analyze-v2 的卡，visual 仍是 {}），
   * 于是图生图的「保持」和「照结构生成」的骨架永远退回通用口径。
   */
  console.log('附图 / 不附图两种 prompt：')
  const noImg = buildAnalyzePrompt(item, false)
  ok(noImg.system.includes('"visual": {}'), '不附图 → visual 固定空对象')
  ok(
    /没有附图/.test(noImg.system) && !noImg.system.includes('"composition"'),
    '不附图 → 不再索要画面字段（免得模型瞎猜）'
  )
  ok(
    VISUAL.every((k) => !noImg.system.includes('"' + k + '"')),
    '不附图时 8 个画面键一个都不出现'
  )
  ok(
    KEYS.every((k) => noImg.system.includes('"' + k + '"')),
    '文字维度不受影响（没有图也能拆结构）'
  )
  ok(
    !system.includes(FENCE) && /只输出一个 JSON 对象/.test(system),
    '要求纯 JSON 输出（不要 Markdown 围栏）'
  )
  ok(user.includes('小红书') && user.includes('标题: 成都人自己的火锅'), 'user 侧带上平台与标题')
  ok(user.includes('赞1200'), 'user 侧带上互动数据（判断为什么火要用）')
  ok(
    describeItem({ ...item, text: 'x'.repeat(3000) }).length < 2000,
    '正文超长时截断（不把 prompt 撑爆）'
  )

  console.log('模型输出解析（容忍围栏/杂文）：')
  const fenced =
    '好的，这是结果:\n' +
    FENCE +
    'json\n{"hook":"现切现涮","visual":{"composition":"居中对称","camera":"俯拍"}}\n' +
    FENCE
  const parsed = parseModelJson(fenced)
  ok(parsed !== null && parsed.hook === '现切现涮', '带 Markdown 围栏也能取出 JSON')
  ok(!!parsed?.visual && parsed.visual.camera === '俯拍', '嵌套的 visual 子对象原样保留')
  ok(parseModelJson('{"a":{"b":{"c":1}}}').a.b.c === 1, '嵌套大括号按平衡扫描（不是找最后一个 }）')
  ok(parseModelJson('{"a":"含 } 的字符串"}').a === '含 } 的字符串', '字符串里的括号不干扰扫描')
  ok(parseModelJson('没有 JSON') === null, '没有 JSON → null（调用方给可读错误）')
  ok(parseModelJson('{坏 json}') === null, '坏 JSON → null，不抛错')
} finally {
  try {
    rmSync(work, { recursive: true, force: true })
  } catch {
    /* Windows 偶发占用 */
  }
}

console.log(failed === 0 ? '\n全部通过 ✅' : '\n' + failed + ' 项失败 ❌')
process.exit(failed === 0 ? 0 : 1)
