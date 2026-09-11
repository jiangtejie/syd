/**
 * 音频工具（纯函数，零 IO）：WAV 封装 + 采样率转换。
 *
 * 为什么需要重采样：微信语音是 24kHz 单声道 PCM，而 whisper.cpp 只吃 **16kHz** WAV。
 * 直接把 24k 当 16k 喂进去，音高和时长都会错（转写质量明显下降），所以这里做一次正经的
 * 「低通 + 线性插值」重采样：先按目标奈奎斯特频率砍掉高频（否则 8k 以上的能量会折叠成噪声），
 * 再按比例插值。语音识别对相位不敏感，这个精度足够，而且完全是纯函数、可离线自检。
 */

/** 44 字节 WAV 头 + PCM（16bit 单声道） */
export function wrapPcmToWav(pcm: Buffer, sampleRate = 24000, channels = 1): Buffer {
  const header = Buffer.alloc(44)
  const byteRate = sampleRate * channels * 2
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(channels * 2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/** WAV(16bit 单声道) 时长毫秒 */
export function wavDurationMs(wav: Buffer, sampleRate = 24000): number {
  const dataBytes = Math.max(0, wav.length - 44)
  return Math.round((dataBytes / 2 / sampleRate) * 1000)
}

/** 汉明窗 sinc 低通：taps 为奇数，cutoff 为归一化截止频率（cycles/sample，0.5 = 奈奎斯特） */
function lowPassKernel(taps: number, cutoff: number): Float64Array {
  const kernel = new Float64Array(taps)
  const mid = (taps - 1) / 2
  let sum = 0
  for (let i = 0; i < taps; i += 1) {
    const x = i - mid
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x)
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1)) // 汉明窗
    kernel[i] = sinc * window
    sum += kernel[i]
  }
  for (let i = 0; i < taps; i += 1) kernel[i] /= sum || 1 // 归一化，保持直流增益为 1
  return kernel
}

/**
 * 16bit 单声道 PCM 重采样。
 * srcRate === dstRate 时原样返回；否则「低通（抗折叠）→ 线性插值」。
 */
export function resamplePcm16(pcm: Buffer, srcRate: number, dstRate: number): Buffer {
  if (srcRate === dstRate || pcm.length < 4) return pcm
  if (srcRate <= 0 || dstRate <= 0) return pcm

  const inFrames = Math.floor(pcm.length / 2)
  const samples = new Float64Array(inFrames)
  for (let i = 0; i < inFrames; i += 1) samples[i] = pcm.readInt16LE(i * 2)

  // 1) 抗折叠低通：截止 = min(目标奈奎斯特, 源奈奎斯特) / 源采样率
  const cutoff = Math.min(0.5, dstRate / 2 / srcRate) * 0.94 // 留一点过渡带
  const taps = 33
  const kernel = lowPassKernel(taps, cutoff)
  const half = (taps - 1) / 2
  const filtered = new Float64Array(inFrames)
  for (let i = 0; i < inFrames; i += 1) {
    let acc = 0
    for (let k = 0; k < taps; k += 1) {
      const idx = i + k - half
      if (idx < 0 || idx >= inFrames) continue
      acc += samples[idx] * kernel[k]
    }
    filtered[i] = acc
  }

  // 2) 线性插值到目标长度
  const outFrames = Math.max(1, Math.round((inFrames * dstRate) / srcRate))
  const out = Buffer.alloc(outFrames * 2)
  const step = srcRate / dstRate
  for (let i = 0; i < outFrames; i += 1) {
    const pos = i * step
    const i0 = Math.floor(pos)
    const i1 = Math.min(inFrames - 1, i0 + 1)
    const frac = pos - i0
    const a = filtered[Math.min(i0, inFrames - 1)]
    const b = filtered[i1]
    const v = a + (b - a) * frac
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2)
  }
  return out
}

/** 语音识别目标采样率（whisper.cpp 固定 16kHz） */
export const ASR_SAMPLE_RATE = 16000
