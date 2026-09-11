/**
 * 语音转写的纯逻辑（零 IO、零依赖，可离线自检）：命令行拼装 + 输出清理。
 * 独立成文件是为了能在自检里直接验证「参数不注入」「噪声输出被清干净」这类细节。
 */

export interface WhisperArgsInput {
  wavPath: string
  modelPath: string
  /** 输出前缀：whisper.cpp 会写 <outBase>.txt */
  outBase: string
  language?: string
  threads?: number
  /** 额外参数（原样追加，调用方自行保证安全） */
  extra?: string[]
}

/**
 * 拼 whisper.cpp 的命令行参数（数组形式 → 用 execFile 直接执行，不经 shell，
 * 路径里有空格/引号也不会被当成参数分隔）。
 */
export function buildWhisperArgs(input: WhisperArgsInput): string[] {
  const args = [
    '-m',
    input.modelPath,
    '-f',
    input.wavPath,
    '-otxt', // 只要 txt，别生成 srt/vtt/json
    '-of',
    input.outBase, // 输出前缀
    '-np' // 静默：不打印进度条，避免 stdout 噪音
  ]
  if (input.language) args.push('-l', input.language)
  if (typeof input.threads === 'number' && input.threads > 0) {
    args.push('-t', String(Math.floor(input.threads)))
  }
  if (input.extra?.length) args.push(...input.extra)
  return args
}

/** 需要被清掉的噪声标记（whisper 对静音/音乐段会输出这些） */
const NOISE_RE =
  /\[(?:blank_?audio|silence|music|noise|inaudible|applause|laughter|sound|beep|\s*)\]|\((?:music|silence|noise|applause|laughter|inaudible)\)/gi
/** 时间戳行：[00:00.000 --> 00:02.000] */
const TIMESTAMP_RE =
  /\[\d{1,2}:\d{2}(?::\d{2})?[.,]\d{0,3}\s*-->\s*\d{1,2}:\d{2}(?::\d{2})?[.,]\d{0,3}\]/g

/** 把 whisper 原始输出清成「一行可读文本」；全是噪声时返回空串（调用方据此判定没听清） */
export function cleanTranscript(raw: string): string {
  if (!raw) return ''
  const text = raw
    .replace(/\r\n?/g, '\n')
    .replace(TIMESTAMP_RE, ' ')
    .replace(NOISE_RE, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text
}

/** 语音缓存里转写产物的文件名（与 WAV 同名、改扩展名，便于按 serverId 直接查） */
export function transcriptNameFor(wavName: string): string {
  return wavName.replace(/\.wav$/i, '') + '.txt'
}
