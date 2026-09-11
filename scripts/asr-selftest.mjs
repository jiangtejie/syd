#!/usr/bin/env node
/**
 * 语音转写相关纯逻辑自检（离线，不需要 whisper 本体）：
 *   node scripts/asr-selftest.mjs
 *
 * 覆盖三件容易出错、又不需要模型就能验的事：
 * 1. 采样率转换：微信语音 24kHz → whisper 只吃 16kHz，直接当 16kHz 喂会变调；
 *    这里断言「长度按比例、通带音高不变、超过目标奈奎斯特的高频被压掉」（抗折叠低通真的生效）。
 * 2. whisper 命令行拼装：参数顺序/可选参数/参数注入（路径带引号或空格）。
 * 3. 转写文本清理：whisper 会输出 [00:00.000 --> 00:02.000]、空行、括号噪声，需要清干净。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundleDir = mkdtempSync(join(tmpdir(), 'dsh-asr-'))
const audioBundle = join(bundleDir, 'audio.cjs')
const asrBundle = join(bundleDir, 'asr.cjs')
buildSync({
  entryPoints: [join(root, 'src/main/services/media/audio.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: audioBundle
})
buildSync({
  entryPoints: [join(root, 'src/main/services/media/asrPure.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: asrBundle
})
const { resamplePcm16, wrapPcmToWav, wavDurationMs, ASR_SAMPLE_RATE } = require(audioBundle)
const { buildWhisperArgs, cleanTranscript } = require(asrBundle)

let failed = 0
const log = (ok, name, detail) => {
  if (!ok) failed++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`)
}

/** 生成正弦波 PCM（16bit 单声道） */
const sine = (freq, rate, ms, amp = 12000) => {
  const n = Math.round((rate * ms) / 1000)
  const buf = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i += 1) {
    buf.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * freq * i) / rate)), i * 2)
  }
  return buf
}
const rms = (pcm) => {
  const n = Math.floor(pcm.length / 2)
  let sum = 0
  for (let i = 0; i < n; i += 1) sum += pcm.readInt16LE(i * 2) ** 2
  return Math.sqrt(sum / Math.max(1, n))
}
/** 过零率估频（对纯正弦够用） */
const estimateFreq = (pcm, rate) => {
  const n = Math.floor(pcm.length / 2)
  let crossings = 0
  for (let i = 1; i < n; i += 1) {
    const a = pcm.readInt16LE((i - 1) * 2)
    const b = pcm.readInt16LE(i * 2)
    if ((a < 0 && b >= 0) || (a >= 0 && b < 0)) crossings += 1
  }
  return (crossings / 2) * (rate / n)
}

// 1) 24kHz → 16kHz
{
  const rate = 24000
  const pcm = sine(1000, rate, 200)
  const out = resamplePcm16(pcm, rate, ASR_SAMPLE_RATE)
  const inFrames = pcm.length / 2
  const outFrames = out.length / 2
  const expect = Math.round((inFrames * ASR_SAMPLE_RATE) / rate)
  log(outFrames === expect, '输出采样点数按比例（24k→16k 为 2/3）', `${inFrames} → ${outFrames}（期望 ${expect}）`)

  const f = estimateFreq(out, ASR_SAMPLE_RATE)
  log(Math.abs(f - 1000) < 60, '通带音高保持（1kHz 正弦重采样后仍是 1kHz）', `估计 ${f.toFixed(0)}Hz`)

  // 10.5kHz 超过目标奈奎斯特(8kHz)：必须被低通压掉，否则会折叠成 5.5kHz 噪声
  const alias = sine(10500, rate, 200)
  const aliasOut = resamplePcm16(alias, rate, ASR_SAMPLE_RATE)
  const ratio = rms(aliasOut) / Math.max(1, rms(alias))
  log(ratio < 0.2, '超过目标奈奎斯特的高频被抗折叠低通压掉', `残留 ${(ratio * 100).toFixed(1)}%`)

  const same = resamplePcm16(pcm, rate, rate)
  log(same === pcm, '源/目标采样率相同则原样返回（不做无谓计算）')
  log(resamplePcm16(Buffer.alloc(0), 24000, 16000).length === 0, '空输入不炸')
}

// 2) WAV 封装与时长
{
  const pcm = sine(440, 24000, 1000)
  const wav = wrapPcmToWav(pcm, 24000)
  const okHeader =
    wav.toString('latin1', 0, 4) === 'RIFF' &&
    wav.toString('latin1', 8, 12) === 'WAVE' &&
    wav.readUInt16LE(22) === 1 &&
    wav.readUInt32LE(24) === 24000 &&
    wav.readUInt32LE(40) === pcm.length
  log(okHeader, 'WAV 头正确（RIFF/WAVE/单声道/采样率/数据长度）')
  log(wavDurationMs(wav, 24000) === 1000, 'WAV 时长换算正确', String(wavDurationMs(wav, 24000)))
}

// 3) whisper 命令行拼装（含路径注入）
{
  const args = buildWhisperArgs({
    wavPath: 'C:/tmp/voice 1.wav',
    modelPath: 'C:/models/ggml-medium.bin',
    outBase: 'C:/tmp/voice 1',
    language: 'zh',
    threads: 4
  })
  log(args.includes('-m') && args[args.indexOf('-m') + 1] === 'C:/models/ggml-medium.bin', '模型参数正确')
  log(args.includes('-f') && args[args.indexOf('-f') + 1] === 'C:/tmp/voice 1.wav', '输入文件作为独立参数（路径带空格也安全，不走 shell）')
  log(args.includes('-l') && args[args.indexOf('-l') + 1] === 'zh', '语言参数正确')
  log(args.includes('-t') && args[args.indexOf('-t') + 1] === '4', '线程参数正确')
  log(args.includes('-otxt') && args.includes('-of'), '要求输出 txt 并指定输出前缀')
  log(!args.some((a) => /[;&|><]/.test(a.replace(/[A-Za-z]:\//g, ''))), '参数里没有 shell 元字符拼接（全程 execFile 不走 shell）')

  const minimal = buildWhisperArgs({ wavPath: 'a.wav', modelPath: 'm.bin', outBase: 'a' })
  log(!minimal.includes('-l'), '未指定语言时不传 -l（交给模型自动判定）')
  log(minimal.includes('-np') || minimal.includes('--no-prints'), '默认静音输出，避免解析进度条')
}

// 4) 转写文本清理
{
  const raw = [
    '[00:00.000 --> 00:02.000]  你好，我想问一下物流',
    '',
    '[00:02.000 --> 00:04.000]  这个订单什么时候能到？',
    '[BLANK_AUDIO]',
    '  '
  ].join('\n')
  const text = cleanTranscript(raw)
  log(text === '你好，我想问一下物流 这个订单什么时候能到？', '去掉时间戳/空行/噪声标记并合并成一句', JSON.stringify(text))
  log(cleanTranscript('') === '', '空输入返回空串')
  log(cleanTranscript('[MUSIC]\n[BLANK_AUDIO]') === '', '纯噪声输出被清成空串（据此判定「没听清」）')
  log(!cleanTranscript('有内容\n\n\n还有内容').includes('\n'), '多行合并为单行')
}

rmSync(bundleDir, { recursive: true, force: true })
console.log(`\n${failed === 0 ? '全部通过' : failed + ' 项失败'}`)
process.exit(failed === 0 ? 0 : 1)
