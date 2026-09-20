/**
 * ffmpeg 解析现状的**共享契约**（主进程产出、设置页消费）。
 *
 * 为什么值得单独一个文件：设置页要说的那句话必须与主进程的判定**同源**。
 * 「随包已就绪，你不用填」和「正在回退到系统 PATH」是两种完全不同的处置建议 ——
 * 判定与文案各写一套，迟早会出现「判定在用随包、文案却说没找到」这种自相矛盾的界面。
 *
 * 背景：这套参数只需要 `hevc 解码 + mjpeg 编码 + hevc 解复用` 三样能力，
 * 所以随包带一份是可行的（见 resources/bin/NOTICE.md），正常安装的用户**本就不该被要求填路径**。
 */

/** 实际会用的那一条来自哪里 */
export type FfmpegSource = 'configured' | 'env' | 'bundled' | 'path'

export interface FfmpegStatus {
  /** 实际会执行的路径（source==='path' 时是交给 spawn 解析的裸名） */
  path: string
  source: FfmpegSource
  /** 随包二进制（electron-builder extraResources: resources/bin） */
  bundled: {
    path: string
    exists: boolean
    /** 体积，取不到为 null */
    sizeMb: number | null
    /** 版本（来自随包的 NOTICE.md），读不到为 null */
    version: string | null
  }
  /** 用户在设置里填的覆盖路径（app_config: media.ffmpegPath） */
  configured: string
  configuredExists: boolean
  /** 环境变量 WECHAT_CS_FFMPEG */
  envPath: string
  envExists: boolean
}

export interface FfmpegSummary {
  /** 一句话状态（设置页主行） */
  text: string
  /** ok=开箱可用；info=被覆盖但在用；warn=需要用户动手 */
  tone: 'ok' | 'info' | 'warn'
}

/**
 * 状态 → 给人看的一句话。
 *
 * 措辞刻意先说**结论**（要不要你管），再说细节 —— 此前设置页摆一个空输入框，
 * 用户不知道「不填会怎样」，于是要么反复纠结，要么随便填一个路径把好的随包二进制盖掉。
 */
export function ffmpegSummary(s: FfmpegStatus | null | undefined): FfmpegSummary {
  if (!s) return { text: '正在读取 ffmpeg 状态…', tone: 'info' }
  const ver = s.bundled.version ? ' · ' + s.bundled.version : ''
  const size = s.bundled.sizeMb != null ? ' · ' + s.bundled.sizeMb + ' MB' : ''
  switch (s.source) {
    case 'bundled':
      return { text: '随包 ffmpeg 已就绪，无需配置' + ver + size, tone: 'ok' }
    case 'configured':
      return s.configuredExists
        ? { text: '正在使用你指定的路径（已覆盖随包）', tone: 'info' }
        : { text: '你指定的路径不存在 —— 解密会失败，请改正或清空以回到随包', tone: 'warn' }
    case 'env':
      return { text: '正在使用环境变量 WECHAT_CS_FFMPEG 指定的路径', tone: 'info' }
    default:
      return {
        text: '未找到随包 ffmpeg，将回退到系统 PATH 上的 ffmpeg（不保证存在）—— HEVC 原图可能只能出缩略图',
        tone: 'warn'
      }
  }
}
