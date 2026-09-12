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
const { parseMediaPath, toMediaUrl, toVoiceMediaUrl, parseRangeHeader, mimeForMediaFile } =
  require(bundle)

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

// 7) Range 解析：<audio> 靠 206 + Content-Range 才能拖进度条，三态必须严格区分
{
  const SIZE = 1000

  // 7.1 无 Range 头 → null（回 200 全量）
  log(parseRangeHeader(null, SIZE) === null, '无 Range 头 → null（200 全量）')
  log(parseRangeHeader('', SIZE) === null, '空 Range 头 → null')
  log(parseRangeHeader('items=0-1', SIZE) === null, '非 bytes 单位 → null（不做 Range）')

  // 7.2 常规三段：Chromium 起播发的是 `bytes=0-`
  const open = parseRangeHeader('bytes=0-', SIZE)
  log(
    open?.start === 0 && open?.end === SIZE - 1,
    'bytes=0- → 整段（Chromium 起播请求）',
    JSON.stringify(open)
  )
  const mid = parseRangeHeader('bytes=100-199', SIZE)
  log(mid?.start === 100 && mid?.end === 199, 'bytes=100-199 → 闭区间原样', JSON.stringify(mid))
  const tail = parseRangeHeader('bytes=500-', SIZE)
  log(tail?.start === 500 && tail?.end === SIZE - 1, 'bytes=500- → 到文件尾', JSON.stringify(tail))

  // 7.3 end 越界要收敛到 size-1，而不是照抄请求值（照抄会让 Content-Length 虚高）
  const over = parseRangeHeader('bytes=900-99999', SIZE)
  log(over?.start === 900 && over?.end === SIZE - 1, 'end 越界 → 收敛到 size-1', JSON.stringify(over))

  // 7.4 后缀式：bytes=-N 取末尾 N 字节（WAV 头尾探测会用到）
  const suffix = parseRangeHeader('bytes=-200', SIZE)
  log(
    suffix?.start === SIZE - 200 && suffix?.end === SIZE - 1,
    'bytes=-200 → 末尾 200 字节',
    JSON.stringify(suffix)
  )
  const suffixOver = parseRangeHeader('bytes=-99999', SIZE)
  log(suffixOver?.start === 0, 'bytes=-超出文件 → 收敛到 0', JSON.stringify(suffixOver))

  // 7.5 语法合法但落在文件外 → 'invalid'（调用方回 416）
  const invalids = [
    ['bytes=1000-', 'start == size'],
    ['bytes=2000-3000', 'start 越界'],
    ['bytes=300-200', 'end < start'],
    ['bytes=-0', '后缀 0 字节'],
    ['bytes=abc-def', '非数字'],
    ['bytes=1', '缺连字符']
  ]
  for (const [header, label] of invalids) {
    log(parseRangeHeader(header, SIZE) === 'invalid', `Range 非法 → 416：${label}`, header)
  }
  log(parseRangeHeader('bytes=0-9', 0) === 'invalid', '空文件上的 Range → 416')
  // 宽松处理：`bytes=` 连范围都没有，按「没有 Range」回全量，比回 416 更不容易让播放器卡死
  log(parseRangeHeader('bytes=', SIZE) === null, '空 spec → 当作没有 Range（200 全量）')

  // 7.6 多段只取第一段（Chromium 媒体栈只发单段，不实现 multipart/byteranges）
  const multi = parseRangeHeader('bytes=10-19,30-39', SIZE)
  log(multi?.start === 10 && multi?.end === 19, '多段 Range 只取第一段', JSON.stringify(multi))
}

// 8) MIME：Range 响应要自带 Content-Type（net.fetch 那条路是 Chromium 嗅探的）
{
  log(mimeForMediaFile('123.wav') === 'audio/wav', 'wav → audio/wav')
  log(mimeForMediaFile('a'.repeat(32) + '_orig.jpg') === 'image/jpeg', 'jpg → image/jpeg')
  log(mimeForMediaFile('a'.repeat(32) + '_thumb.MP4') === 'video/mp4', '扩展名大小写不敏感')
  log(mimeForMediaFile('nope') === 'application/octet-stream', '认不出的扩展名 → octet-stream')
}

rmSync(bundleDir, { recursive: true, force: true })
console.log(`\n${failed === 0 ? '全部通过' : failed + ' 项失败'}`)
process.exit(failed === 0 ? 0 : 1)
