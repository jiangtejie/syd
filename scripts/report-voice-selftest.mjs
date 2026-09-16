#!/usr/bin/env node
/**
 * 上报链路的语音自检（纯函数，零依赖）：
 *   node --experimental-strip-types scripts/report-voice-selftest.mjs
 *
 * 为什么值得钉死：语音是唯一「消息里只有占位、真内容在别处」的类型 ——
 * 读取层合流、落库两列、转写挑选、归档命名四处口径只要有一处写歪，
 * 表现都是「库里还是 [语音]」，肉眼分不出是哪一处错。
 */
import {
  composeVoiceContent,
  DEFAULT_ASR_PER_RUN,
  MAX_ASR_DURATION_MS,
  parseVoiceParsedContent,
  pickVoiceAsrTasks,
  transcriptNameFor,
  voiceArchiveName,
  voiceCacheName,
  voiceColumnsOf,
  voiceRowOf,
  voiceTimeCandidates
} from '../src/main/services/media/voiceText.ts'
import { contentFor, localTypeName } from '../src/main/services/report/messageText.ts'

let failed = 0
const log = (ok, name, detail) => {
  if (!ok) failed++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`)
}

console.log('\n[1] 内容组装/解析：[语音] N″ 文本 一个口径')
log(composeVoiceContent(8, '你好') === '[语音] 8″ 你好', '有时长有文本', composeVoiceContent(8, '你好'))
log(composeVoiceContent(8, '') === '[语音] 8″', '只有时长', composeVoiceContent(8, ''))
log(composeVoiceContent(null, '你好') === '[语音] 你好', '只有文本', composeVoiceContent(null, '你好'))
log(composeVoiceContent(null, '  ') === '[语音]', '都没有 → 纯占位', composeVoiceContent(null, '  '))
log(composeVoiceContent(7.6, 'x') === '[语音] 8″ x', '秒数四舍五入')

const p1 = parseVoiceParsedContent('[语音] 8″ 好，我们看一下')
log(p1.seconds === 8 && p1.text === '好，我们看一下', '解析带时长', JSON.stringify(p1))
log(parseVoiceParsedContent('[语音]').text === '', '占位 → 无文本')
log(parseVoiceParsedContent('[图片]').text === '', '非语音 → 无文本')
log(parseVoiceParsedContent('[语音] 5″').seconds === 5, '只有时长也能解析出秒数')
log(
  parseVoiceParsedContent(composeVoiceContent(12, '带″的文本 3″')).text === '带″的文本 3″',
  '组装→解析 round-trip（文本里的 ″ 不被吃掉）'
)

console.log('\n[2] 缓存命名：与 voice.ts 的 <serverId | localId>.wav 一致')
log(voiceCacheName('7104839571854557000', 42) === '7104839571854557000.wav', 'serverId 优先')
log(voiceCacheName('', 42) === '42.wav', '无 serverId 退回 localId（缓存里真实存在 47.wav）')
log(voiceCacheName('', 0) === '', '都没有 → 空串')
log(transcriptNameFor('42.wav') === '42.txt', '转写产物同名换扩展名')
log(transcriptNameFor('x.WAV') === 'x.txt', '大小写不敏感')

console.log('\n[2b] create_time 单位候选：VoiceInfo 实测存秒，界面/上报可能给毫秒')
log(
  JSON.stringify(voiceTimeCandidates(1789355819)) ===
    JSON.stringify([
      { value: 1789355819, tolerance: 60 },
      { value: 1789355819000, tolerance: 60000 }
    ]),
  '秒 → 先按秒试、再按毫秒兜底',
  JSON.stringify(voiceTimeCandidates(1789355819))
)
log(
  JSON.stringify(voiceTimeCandidates(1789355819000)) ===
    JSON.stringify([
      { value: 1789355819000, tolerance: 60000 },
      { value: 1789355819, tolerance: 60 }
    ]),
  '毫秒 → 先按毫秒试、再按秒兜底（这次线上就是毫秒一路 miss）',
  JSON.stringify(voiceTimeCandidates(1789355819000))
)
log(
  voiceTimeCandidates(0).length === 1 && voiceTimeCandidates(undefined)[0].tolerance === 0,
  '没有时间戳 → 只按 local_id 查（无窗口）'
)

console.log('\n[3] 消息 → 语音任务行')
const voiceMsg = { localType: 34, localId: 49, serverId: '8431291791001192000', createTime: 1789538667000, voiceDuration: 8000 }
const row = voiceRowOf('44985433530@chatroom', voiceMsg)
log(row && row.localId === 49 && row.serverId === '8431291791001192000', '语音消息成行')
log(row && row.durationMs === 8000, '时长带出来（毫秒）')
log(voiceRowOf('g', { localType: 1, localId: 3, serverId: 'x' }) === null, '文本消息不成行')
log(voiceRowOf('g', { localType: 34, localId: 0, serverId: '' }) === null, '没有定位键 → null')
log(voiceRowOf('g', { localType: 34, localId: 0, serverId: 'svr1' })?.serverId === 'svr1', '只有 serverId 也行')

console.log('\n[4] 挑选：预算=尝试次数、新→旧、跳过已转写/超长/失败过的')
const rows = [
  { sessionWxid: 'g1', localId: 1, serverId: 's1', createTime: 1000, durationMs: 5000 },
  { sessionWxid: 'g1', localId: 2, serverId: 's2', createTime: 5000, durationMs: 5000 },
  { sessionWxid: 'g1', localId: 3, serverId: 's3', createTime: 3000, durationMs: 5000 },
  { sessionWxid: 'g2', localId: 4, serverId: 's4', createTime: 2000, durationMs: 90000 },
  { sessionWxid: 'g2', localId: 5, serverId: 's5', createTime: 4000, durationMs: 5000 }
]
const picked = pickVoiceAsrTasks(rows, { hasTranscript: () => false, budget: 3 })
log(picked.length === 3, '预算 3 → 3 条', String(picked.length))
log(picked.map((t) => t.cacheName).join(',') === 's2.wav,s5.wav,s3.wav', '新→旧排序（超长的 s4 跳过）', picked.map((t) => t.cacheName).join(','))
log(picked[0].seconds === 5, '带出秒数供拼内容')
log(
  pickVoiceAsrTasks(rows, { hasTranscript: (n) => n === 's2.wav', budget: 3 }).map((t) => t.cacheName).join(',') === 's5.wav,s3.wav,s1.wav',
  '已转写的跳过'
)
log(
  pickVoiceAsrTasks(rows, { hasTranscript: () => false, budget: 3, skip: (n) => n === 's2.wav' }).map((t) => t.cacheName).join(',') === 's5.wav,s3.wav,s1.wav',
  '连续失败的跳过（进程内记忆）'
)
log(
  pickVoiceAsrTasks(rows, { hasTranscript: (n) => n === '1.txt', budget: 3 })
    .map((t) => t.cacheName)
    .join(',') === 's2.wav,s5.wav,s3.wav',
  '历史命名（<localId>.txt）也算已转写 → 跳过 s1（localId=1）',
  pickVoiceAsrTasks(rows, { hasTranscript: (n) => n === '1.txt', budget: 3 }).map((t) => t.cacheName).join(',')
)
log(pickVoiceAsrTasks(rows, { hasTranscript: () => false, budget: 0 }).length === 0, '预算 0 → 不做事')
log(pickVoiceAsrTasks([{ ...rows[0] }, { ...rows[0] }], { hasTranscript: () => false, budget: 5 }).length === 1, '同一条语音（分片库重复）去重')
log(MAX_ASR_DURATION_MS === 60000, '腾讯云一句话识别 60s 上限写死在这里')
log(DEFAULT_ASR_PER_RUN === 5, '默认每轮 5 条（与渲染端表单默认值一致）')

console.log('\n[5] 归档命名')
log(voiceArchiveName('8431291791001192000', 49) === '8431291791001192000_voice.wav', 'serverId 命名')
log(voiceArchiveName('', 47) === '47_voice.wav', 'localId 命名')
log(voiceArchiveName('', 0) === null, '无定位键 → null')

console.log('\n[6] 落库两列：voice_text / voice_duration_ms')
const colTranscribed = voiceColumnsOf({ localType: 34, parsedContent: '[语音] 8″ 好，我们看一下', voiceDuration: 8000 })
log(colTranscribed.voiceText === '好，我们看一下', '已转写 → 文本入列', String(colTranscribed.voiceText))
log(colTranscribed.voiceDurationMs === 8000, '时长来自 XML voicelength', String(colTranscribed.voiceDurationMs))
const colPlain = voiceColumnsOf({ localType: 34, parsedContent: '[语音]', voiceDuration: 8000 })
log(colPlain.voiceText === null, '未转写 → voice_text 为 null')
log(colPlain.voiceDurationMs === 8000, '未转写也有时长（下游能按"语音多长"统计）')
const colNoXml = voiceColumnsOf({ localType: 34, parsedContent: '[语音] 6″ 嗯' })
log(colNoXml.voiceText === '嗯' && colNoXml.voiceDurationMs === 6000, 'XML 缺时长时用内容里的秒数兜底')
const colText = voiceColumnsOf({ localType: 1, parsedContent: '你好' })
log(colText.voiceText === null && colText.voiceDurationMs === null, '非语音 → 两列全 null')

console.log('\n[7] 类型名与占位正文（不受语音改动影响）')
log(localTypeName({ localType: 34 }) === '语音消息', '34 → 语音消息（chat-sync 命名）')
log(localTypeName({ localType: 1 }) === '文本消息', '1 → 文本消息')
log(localTypeName({ localType: 49, fileName: 'a.pdf' }) === '文件消息', '49 型按字段细分')
log(contentFor({ parsedContent: '[语音] 8″ 文本' }, '语音消息') === '[语音] 8″ 文本', '有解析结果就用解析结果')
log(contentFor({ parsedContent: '' }, '语音消息') === '[语音]', '解析为空 → 类型占位')

console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项未通过 ❌`)
process.exit(failed === 0 ? 0 : 1)
