#!/usr/bin/env node
/**
 * wxgf（微信 HEVC 图片容器）解析的自检（纯函数，零依赖）：
 *   node --experimental-strip-types scripts/wxgf-nal-selftest.mjs
 *
 * 为什么值得钉死：这里出过一次「静默地把白图当结果」的故障 —— 微信常在真图前放一张纯白占位帧，
 * 而切 NAL 时把起始码一起切进了 unit，`hevcNalType(unit)` 读到的永远是起始码首字节 0x00，
 * 于是「按 VPS 分组」从来没生效，整个文件被当成一段，ffmpeg 只解第一张 = 纯白。
 * 实测本机 232 张 HEVC 默认图里 42 张（18%）如此。这条自检用合成样本把分组不变量钉死：
 * **每个 NAL 段必须以 00 00 00 01 开头、紧跟其后的必须是 NAL 头（VPS=0x40）**，
 * 且两张图的文件必须分出两段。
 */
import {
  WXGF_MIN_FRAME_BYTES,
  extractEmbeddedImage,
  extractHevcNaluStreams,
  extractWxgfViewable,
  extractWxgfViewableDetailed,
  isWxgf
} from '../src/main/services/media/datDecrypt.ts'

let failed = 0
const log = (ok, name, detail) => {
  if (!ok) failed++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`)
}

const START4 = Buffer.from([0, 0, 0, 1])
const START3 = Buffer.from([0, 0, 1])
/** 造一个 NAL：2 字节头（type + temporal_id_plus1）+ 填充载荷（0xab，不含 00 00 01） */
const nal = (type, payloadLen) =>
  Buffer.concat([Buffer.from([(type << 1) & 0x7f, 1]), Buffer.alloc(payloadLen, 0xab)])
/** 造一个 wxgf：'wxgf' + 12 字节容器头 + 若干（起始码 + NAL） */
const wxgf = (units, start = START4) =>
  Buffer.concat([Buffer.from('wxgf'), Buffer.alloc(12), ...units.flatMap((u) => [start, u])])

// 微信真实布局：先一张纯白占位帧（IDR 仅百来字节），再一张真图
const placeholder = [nal(32, 23), nal(33, 42), nal(34, 7), nal(19, 120)]
const realPicture = [nal(32, 24), nal(33, 43), nal(34, 7), nal(19, 20000)]

console.log('\n[1] 两张图的 wxgf 必须分出两段（分组曾经因为起始码而完全失效）')
const two = wxgf([...placeholder, ...realPicture])
const streams = extractHevcNaluStreams(two)
log(streams.length === 2, '占位帧 + 真图 → 2 段', '实际 ' + streams.length)
log(
  streams.every((s) => s.subarray(0, 4).equals(START4)),
  '每段都以 4 字节起始码开头（Annex B）'
)
log(
  streams.every((s) => ((s[4] >> 1) & 0x3f) === 32),
  '起始码之后紧跟的是 VPS 头（0x40）—— 旧实现把起始码当成了 NAL 头，这里必失败',
  streams.map((s) => s[4].toString(16)).join(',')
)
log(
  streams[0].length < streams[1].length,
  '占位帧那段更小（真图在后且更大）',
  streams[0].length + ' < ' + streams[1].length
)

console.log('\n[2] 单张图 / 三字节起始码 / 过小片段')
log(extractHevcNaluStreams(wxgf(realPicture)).length === 1, '单张图 → 1 段')
log(
  extractHevcNaluStreams(wxgf([...placeholder, ...realPicture], START3)).length === 2,
  '三字节起始码同样能分组'
)
log(
  extractHevcNaluStreams(wxgf([nal(32, 5), nal(19, 5)])).length === 0,
  '整段 <100 字节 → 丢弃（过滤过小片段）'
)

console.log('\n[3] 段选择依据：载荷最大的那段才是真图（占位帧解出来也有 6~9KB，不能只看输出大小）')
const byPayload = extractHevcNaluStreams(two).sort((a, b) => b.length - a.length)
log(
  byPayload[0].length > byPayload[1].length,
  '按载荷降序 → 第一段就是真图那段',
  byPayload[0].length + 'B'
)

console.log('\n[4] 没有 ffmpeg 时不猜、不乱解')
log((await extractWxgfViewable(two, null)) === null, '纯 HEVC + 无 ffmpeg 路径 → null')
log(WXGF_MIN_FRAME_BYTES === 1024, '空白/半帧的下限常量 = 1024 字节')

console.log('\n[5] 内嵌 JPEG 优先（不必调 ffmpeg）')
const innerJpeg = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(600, 0x11),
  Buffer.from([0xff, 0xd9])
])
const withEmbedded = Buffer.concat([
  Buffer.from('wxgf'),
  Buffer.alloc(12),
  innerJpeg,
  ...realPicture.flatMap((u) => [START4, u])
])
log(isWxgf(withEmbedded), 'isWxgf 认得容器头')
log(!!extractEmbeddedImage(withEmbedded), '能从 wxgf 里截出内嵌 JPEG')
log(
  (await extractWxgfViewable(withEmbedded, null))?.length === innerJpeg.length,
  '内嵌图优先于 HEVC 解码（无 ffmpeg 也能出图）'
)
log((await extractWxgfViewable(Buffer.from('not-a-wxgf'), null)) === null, '非 wxgf → null')

console.log('\n[6] 失败原因要能区分「可修复」与「真解不出」（界面/日志据此给建议）')
const notWxgf = await extractWxgfViewableDetailed(Buffer.from('not-a-wxgf'), null)
log(
  notWxgf.data === null && notWxgf.reason === 'not-wxgf',
  '非 wxgf → not-wxgf',
  String(notWxgf.reason)
)
const noFfmpeg = await extractWxgfViewableDetailed(wxgf(realPicture), null)
log(
  noFfmpeg.data === null && noFfmpeg.reason === 'no-ffmpeg',
  '纯 HEVC + 没有 ffmpeg → no-ffmpeg（可修复：提示去设置里填路径）',
  String(noFfmpeg.reason)
)
const embeddedOutcome = await extractWxgfViewableDetailed(withEmbedded, null)
log(
  !!embeddedOutcome.data && embeddedOutcome.via === 'embedded',
  '内嵌 JPEG → via=embedded（无需 ffmpeg）',
  String(embeddedOutcome.via)
)

if (failed > 0) {
  console.error(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
