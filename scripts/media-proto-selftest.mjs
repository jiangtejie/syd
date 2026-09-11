#!/usr/bin/env node
/**
 * ct-media 协议路径解析的自检（纯 Node + 离线）：
 *   node scripts/media-proto-selftest.mjs
 *
 * 为什么单独立这条自检：语音 URL 早期把 `voices/xxx.wav` 整体 encodeURIComponent，
 * `/` 变成 %2F 后整条路径只剩两段，被协议判成 403 —— 渲染端只看到播放失败，没有任何线索。
 * 这里把「图片/视频两段布局」「语音三段布局」「各种非法输入」固化成断言。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundleDir = mkdtempSync(join(tmpdir(), 'dsh-media-proto-'))
const bundle = join(bundleDir, 'mediaProtocol.cjs')
buildSync({
  entryPoints: [join(root, 'src/main/services/media/mediaProtocol.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundle
})
const { parseMediaPath, toMediaUrl, toVoiceMediaUrl } = require(bundle)

let failed = 0
const log = (ok, name, detail) => {
  if (!ok) failed++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`)
}

/** 走真实 URL 解析：new URL(...).pathname → parseMediaPath（协议层就是这么拿 pathname 的） */
const parseUrl = (url) => parseMediaPath(new URL(url).pathname)

const WXID = 'wxid_r9l5xuni9ng522_7e0b'
const MD5 = 'a'.repeat(32)

// 1) 图片/视频（既有布局，不能被破坏）
{
  const r = parseUrl(toMediaUrl(WXID, `${MD5}_orig.jpg`))
  log(
    r.hit?.kind === 'asset' && r.hit.wxid === WXID && r.hit.rel[0] === `${MD5}_orig.jpg`,
    '图片 URL 解析为 asset 两段布局',
    JSON.stringify(r.hit)
  )
  const v = parseUrl(toMediaUrl(WXID, `${MD5}_thumb.mp4`))
  log(v.hit?.kind === 'asset' && v.hit.rel[0].endsWith('.mp4'), '视频 URL 解析为 asset')
}

// 2) 语音（三段布局）
{
  const name = '8066580648644796000.wav'
  const url = toVoiceMediaUrl(WXID, name)
  const r = parseUrl(url)
  log(
    r.hit?.kind === 'voice' && r.hit.rel[0] === 'voices' && r.hit.rel[1] === name,
    '语音 URL 解析为 voice 三段布局',
    url
  )
  log(
    url === `ct-media://media/${WXID}/voices/${name}`,
    '语音 URL 不做整体编码（/ 保持为真段）',
    url
  )
}

// 3) 回归：早期「把 voices/x.wav 整体编码」的写法必须判非法（而不是被当成某个资源名）
{
  const bad = `ct-media://media/${WXID}/${encodeURIComponent('voices/1.wav')}`
  const r = parseUrl(bad)
  log(r.hit === null, '整体编码的语音 URL 被拒（回归保护）', bad)
}

// 4) 目录穿越与非法命名
{
  const cases = [
    [`ct-media://media/${WXID}/voices/..%2F..%2Fapp.asar.wav`, '语音名里塞 ../'],
    [`ct-media://media/${WXID}/voices/abc.wav`, '语音名非数字'],
    [`ct-media://media/${WXID}/voices/1.mp3`, '语音扩展名非 wav'],
    [`ct-media://media/${WXID}/voices/1.wav.bak`, '语音名带多余后缀'],
    [`ct-media://media/${WXID}/${MD5}.jpg`, '资源名缺 _kind'],
    [`ct-media://media/${WXID}/../${MD5}_orig.jpg`, '资源段数/命名不合规'],
    [`ct-media://media/wxid:bad/${MD5}_orig.jpg`, 'wxid 含非法字符'],
    [`ct-media://media/${WXID}/voices/voices/1.wav`, '语音段数过多'],
    [`ct-media://media/${MD5}_orig.jpg`, '段数过少']
  ]
  for (const [url, label] of cases) {
    const r = parseUrl(url)
    log(r.hit === null, `拒绝：${label}`, r.hit ? JSON.stringify(r.hit) : 'hit=null')
  }
}

// 5) 形状错误应为 404、命名错误应为 403（协议层据此回不同状态码，便于排查）
{
  const shape = parseMediaPath('/only-one-segment')
  log(shape.hit === null && shape.badShape === true, '段数不对 → badShape=true（404）')
  const named = parseMediaPath(`/${WXID}/voices/abc.wav`)
  log(named.hit === null && named.badShape === false, '命名不合规 → badShape=false（403）')
}

// 6) 畸形百分号转义不应抛异常，只应判非法
{
  let threw = false
  let r = null
  try {
    r = parseMediaPath(`/${WXID}/voices/1%.wav`)
  } catch {
    threw = true
  }
  log(!threw && r?.hit === null, '畸形 % 转义不抛异常且判非法')
}

rmSync(bundleDir, { recursive: true, force: true })
console.log(`\n${failed === 0 ? '全部通过' : failed + ' 项失败'}`)
process.exit(failed === 0 ? 0 : 1)
