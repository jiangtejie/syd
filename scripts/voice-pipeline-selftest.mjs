import { buildSync } from 'esbuild'
import { createRequire } from 'module'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

/**
 * 语音转写「最后一公里」自检（纯函数，不碰库、不碰文件）。
 *
 * 钉住的是一件真发生过的事：腾讯云 ASR 转写已经付费接好、文本也已合流进 parsedContent，
 * 但分析链路取文本时硬编码返回 '[语音]' —— 议题分析与数字员工永远看不到语音内容。
 * 这里断言「有转写就必须读出来」「有转写的语音不再算非文本」。改这三条判定前先跑它。
 */

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'dsh-voice-pipeline-'))

let failed = 0
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  ✔ ' : '  ✖ ') + label + (extra ? ' — ' + extra : ''))
  if (!cond) failed++
}

try {
  const bundle = join(work, 'msgText.cjs')
  buildSync({
    entryPoints: [join(root, 'src/main/services/feedback/msgText.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle
  })
  const { msgToText, hasTranscriptText, isMachineReadable, isRuleText, isTextLike } = require(bundle)

  const voice = (parsed) => ({ localType: 34, parsedContent: parsed })
  const msg = (localType, parsedContent = '') => ({ localType, parsedContent })

  console.log('消息 → 文本：')
  ok(msgToText(msg(1, '孜然粉到货了没')) === '孜然粉到货了没', '文本消息取正文')
  ok(
    msgToText(voice('[语音] 8″ 这批鸡爪明天到不了我就得换供应商')) ===
      '[语音] 8″ 这批鸡爪明天到不了我就得换供应商',
    '有转写的语音必须读出正文（回归：以前硬编码返回 [语音]）'
  )
  ok(msgToText(voice('')) === '[语音]', '没转写的语音退回占位符')
  ok(msgToText(voice('[语音]')) === '[语音]', '占位符原样返回')
  ok(msgToText(msg(3)) === '[图片]', '图片仍是占位符')
  ok(msgToText(msg(43)) === '[视频]', '视频仍是占位符')
  ok(msgToText(msg(99, '自定义')) === '自定义', '未知类型走 parsedContent 兜底')

  console.log('有没有转写：')
  ok(hasTranscriptText('[语音] 8″ 明天到仓') === true, '「[语音] 8″ 正文」算有转写')
  ok(hasTranscriptText('[语音] 8″') === false, '只有时长没有正文 → 不算有转写')
  ok(hasTranscriptText('[语音]') === false, '空占位 → 不算有转写')
  ok(hasTranscriptText('') === false, '空串 → 不算有转写')
  ok(hasTranscriptText(undefined) === false, 'undefined → 不算有转写')

  console.log('机器读不读得懂（决定数字员工是否转人工）：')
  ok(isMachineReadable(msg(1, '在吗')) === true, '文本读得懂')
  ok(isMachineReadable(voice('[语音] 8″ 明天到仓')) === true, '有转写的语音读得懂（回归：以前一律转人工）')
  ok(isMachineReadable(voice('[语音]')) === false, '没转写的语音仍读不懂 → 转人工')
  ok(isMachineReadable(msg(3)) === false, '图片读不懂 → 转人工')
  ok(isMachineReadable(msg(43)) === false, '视频读不懂 → 转人工')
  ok(isMachineReadable(msg(47)) === false, '表情读不懂 → 转人工')
  ok(isRuleText(msg(1)) === true && isRuleText(msg(49)) === false, '规则层仍只吃真文本')
  ok(isTextLike(msg(1)) === true && isTextLike(msg(49)) === true && isTextLike(voice('x')) === false, 'LLM 行过滤口径不变')
} finally {
  try {
    rmSync(work, { recursive: true, force: true })
  } catch {
    /* Windows 偶发占用 */
  }
}

console.log(failed === 0 ? '\n全部通过 ✅' : '\n' + failed + ' 项失败 ❌')
process.exit(failed === 0 ? 0 : 1)
