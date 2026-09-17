/**
 * ffmpeg 可执行文件的**优先级判定**（零依赖，可离线自检）。
 *
 * 背景：这套参数只需要 `hevc 解码 + mjpeg 编码 + hevc 解复用` 三样能力
 * （见 datDecrypt.convertHevcToJpeg 的实际命令行），所以「随包带一个」完全可行 ——
 * 目标机不用再手填路径。
 *
 * 优先级刻意保持既有语义：**用户显式配置 > 环境变量 > 随包 > PATH**。
 * - 显式配置即使文件不存在也原样返回：让人当场发现路径填错，而不是被静默换成别的二进制；
 * - 随包放在 PATH 之前：保证开箱可用，不受目标机 PATH 上恰好有个旧 ffmpeg 影响；
 * - 全都取不到才交给 spawn 报 ENOENT。
 */

export interface FfmpegCandidates {
  /** 用户在设置里填的路径（app_config: media.ffmpegPath） */
  configured: string
  configuredExists: boolean
  /** 环境变量 WECHAT_CS_FFMPEG */
  envPath: string
  envExists: boolean
  /** 随包二进制的绝对路径（打包后在 process.resourcesPath/bin 下） */
  bundled: string
  bundledExists: boolean
}

/** PATH 上的兜底名（交给 spawn 自己解析） */
export const FFMPEG_FALLBACK = 'ffmpeg'

export function pickFfmpegPath(c: FfmpegCandidates): string {
  const configured = (c.configured ?? '').trim()
  if (configured) return configured
  const envPath = (c.envPath ?? '').trim()
  if (envPath && c.envExists) return envPath
  const bundled = (c.bundled ?? '').trim()
  if (bundled && c.bundledExists) return bundled
  return FFMPEG_FALLBACK
}
