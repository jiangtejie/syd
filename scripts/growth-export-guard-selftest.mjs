import { buildSync } from 'esbuild'
import { createRequire } from 'module'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

/**
 * 发布包「安全出口」自检（纯函数，不碰库、不碰文件系统）。
 *
 * 钉住三件会摊上事的事：
 *  ① 违法表述（广告法绝对化用语 / 普通食品功效宣称）**必须拒绝导出**，不是给个提示；
 *  ② 来源=参考的素材图**一张都不许进发布包**（那是别人的作品，随文案发出去就是侵权）；
 *  ③ AI 生成图**必须可识别**（文件名前缀 + 文案声明）。
 * 同时钉住「平台导流词只提示不阻断」—— 导流是本产品的核心用途，一刀切会把主用途堵死。
 */

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'dsh-growth-export-'))

let failed = 0
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  ✔ ' : '  ✖ ') + label + (extra ? ' — ' + extra : ''))
  if (!cond) failed++
}

try {
  const bundle = join(work, 'exportPlan.cjs')
  buildSync({
    entryPoints: [join(root, 'src/main/services/growth/publisher/exportPlan.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle
  })
  const { exportGate, planExportImages, complianceBanner, AI_IMAGE_PREFIX, isAiImage } = require(bundle)

  console.log('合规门禁（block 必须拦下导出）：')
  const g1 = exportGate(['这家店是全市最好吃的火锅'])
  ok(g1.ok === false, '广告法绝对化用语 → 拒绝导出')
  ok(g1.ok === false && g1.error.includes('合规门禁拦截'), '错误文案说清是门禁拦截', g1.ok ? '' : String(g1.error).slice(0, 28))
  ok(g1.ok === false && g1.error.includes('最好吃'), '指出命中的词（用户知道改哪里）')
  const g2 = exportGate(['这款茶喝了能降糖降压'])
  ok(g2.ok === false, '普通食品功效宣称 → 拒绝导出')
  const g3 = exportGate(['新店开业，欢迎来尝'])
  ok(g3.ok === true && g3.warnings.length === 0, '干净文案 → 通过且无提示')

  console.log('非阻断级（提示但不拦，别把主用途堵死）：')
  const g4 = exportGate(['扫码加微信领福利，主页联系我'])
  ok(g4.ok === true, '平台导流词 → 不阻断导出（导流是核心用途）')
  ok(g4.ok === true && g4.warnings.some((w) => w.code === 'diversion'), '但要给出导流提示')
  const g5 = exportGate(['米其林推荐，最后1天，仅限今日'])
  ok(g5.ok === true && g5.warnings.length > 0, '背书/促销紧迫 → 提示而不阻断')

  console.log('图片取材（参考素材一张都不许进包）：')
  const refOnly = planExportImages({
    contentUsage: 'ref',
    contentImages: [
      { kind: 'cover', relPath: 'a/1.jpg' },
      { kind: 'image', relPath: 'a/2.jpg' }
    ],
    outputImages: []
  })
  ok(refOnly.files.length === 0, '来源=参考且无产出图 → 不打包任何图')
  ok(refOnly.withheldRef === 2, '如实记下扣了几张（文案里要告知）', String(refOnly.withheldRef))

  const own = planExportImages({
    contentUsage: 'own',
    contentImages: [
      { kind: 'cover', relPath: 'b/1.jpg' },
      { kind: 'image', relPath: 'b/2.jpg' }
    ],
    outputImages: []
  })
  ok(own.files.length === 2 && own.withheldRef === 0, '自产素材 → 正常打包')
  ok(own.files[0].name === '封面.jpg' && own.files[1].name === '图2.jpg', '命名仍是 封面/图N', own.files.map((f) => f.name).join(','))

  const mixed = planExportImages({
    contentUsage: 'ref',
    contentImages: [{ kind: 'cover', relPath: 'c/ref-cover.jpg' }],
    outputImages: [{ relPath: 'c/out.jpg', source: 'store', note: '' }]
  })
  ok(mixed.usedOutputAssets === true, '有产出图 → 以产出为准（不看素材 usage）')
  ok(mixed.files.length === 1 && mixed.files[0].relPath === 'c/out.jpg', '只打产出的那张，素材里的参考图不进包')
  ok(mixed.withheldRef === 0, '以产出为准时不报「扣下图」（那些图本来就没选）')

  console.log('AI 生成图必须可识别：')
  ok(isAiImage('gen', '') === true, 'source=gen → 判为 AI 图')
  ok(isAiImage('', 'AI 生成示意图(非实拍)') === true, '备注写了 AI 生成 → 判为 AI 图')
  ok(isAiImage('store', '') === false, '门店实拍 → 不是 AI 图')
  const ai = planExportImages({
    contentUsage: 'own',
    contentImages: [],
    outputImages: [
      { relPath: 'd/ai.jpg', source: 'gen', note: 'AI 生成示意图(非实拍)' },
      { relPath: 'd/search.jpg', source: 'search', note: '来源: 联网检索(请确认版权后再发布)' }
    ]
  })
  ok(ai.files[0].isAi === true && ai.files[0].name.startsWith(AI_IMAGE_PREFIX), 'AI 图文件名带前缀', ai.files[0].name)
  ok(ai.files[1].fromSearch === true && ai.files[1].isAi === false, '联网检索图单独标记（版权待确认）')
  const dup = planExportImages({
    contentUsage: 'own',
    contentImages: [
      { kind: 'image', relPath: 'same.jpg' },
      { kind: 'image', relPath: 'same.jpg' }
    ],
    outputImages: []
  })
  ok(dup.files.length === 1, '同一张图不重复打包')

  console.log('文案头部的合规块：')
  const banner = complianceBanner({
    warnings: g4.ok ? g4.warnings : [],
    withheldRef: 3,
    aiCount: 1,
    searchCount: 1,
    origin: 'douyin',
    authorName: '某达人',
    link: 'https://v.douyin.com/xxx'
  })
  ok(banner.includes('AI 生成示意图'), '含 AIGC 声明')
  ok(banner.includes('扣下 3 张'), '含被扣下的参考图说明')
  ok(banner.includes('联网检索图'), '含联网图版权提示')
  ok(banner.includes('人工核对'), '保留人工核对提醒')
  ok(banner.includes('平台导流词'), '把提示级命中写进包里')
  const clean = complianceBanner({ warnings: [], withheldRef: 0, aiCount: 0, searchCount: 0, origin: '', authorName: '', link: '' })
  ok(clean.length > 0 && clean.includes('人工核对'), '没有可提示项时仍有最基础的人工核对声明')
} finally {
  try {
    rmSync(work, { recursive: true, force: true })
  } catch {
    /* Windows 偶发占用 */
  }
}

console.log(failed === 0 ? '\n全部通过 ✅' : '\n' + failed + ' 项失败 ❌')
process.exit(failed === 0 ? 0 : 1)
