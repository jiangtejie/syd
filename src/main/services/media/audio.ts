/**
 * 音频工具（纯函数，零 IO）：WAV 封装与时长换算。
 *
 * 语音转写已改为云侧（腾讯云 ASR），本地 whisper 用的 24k→16k 重采样随之下线；
 * 这里只保留播放与分析链路都要用的基础件。
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
