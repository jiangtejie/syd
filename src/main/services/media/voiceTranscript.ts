import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getVoiceCacheDir } from '../paths'
import { composeVoiceContent, transcriptNameFor } from './voiceText'

/** 转写产物命名与语音缓存一致（`<serverId | localId>.txt`），从 voiceText 统一出口转发 */
export { transcriptNameFor } from './voiceText'

/**
 * 语音转写文本的**读取与合流**（不做识别本身）。
 *
 * 识别引擎按决定改用云侧（腾讯云 ASR），本地 whisper 那条路已下线；这里保留的是「转写产物怎么被用起来」：
 * - 约定：某条语音的转写文本放在语音缓存目录下、与 WAV 同名的 `.txt`（`<媒体缓存>/<wxid>/voices/<id>.txt`）；
 *   `.wav` 会被容量策略淘汰，而文本很小且更值钱，所以淘汰只清 `.wav`、保留 `.txt`（见 voice.ts）。
 * - 合流：消息读取层 enrich 之后调用 `decorateVoiceTranscripts`，把已有转写并进 `parsedContent`
 *   （`[语音] N″ 文本`）——这样界面、议题分析、数字员工读到的是同一份内容，接入云 ASR 时只需往这个目录写文件。
 * - 命名/组装的纯逻辑在 `voiceText.ts`：上报层（report/chatSyncRunner）也要按同一口径落库与规划转写，
 *   那个模块零依赖，自检脚本能直接 import。
 */

/** 已缓存的转写文本（不触发任何识别）；供界面与分析链路按需读取 */
export function readVoiceTranscript(wxid: string, voiceName: string): string | null {
  try {
    const p = join(getVoiceCacheDir(wxid), transcriptNameFor(voiceName))
    if (!existsSync(p)) return null
    const text = readFileSync(p, 'utf8').trim()
    return text || null
  } catch {
    return null
  }
}

/**
 * 按消息找已缓存的转写：先按 `<serverId>.wav`，再退回 `<localId>.wav`。
 *
 * 为什么要兜底：voice.ts 的缓存名是 `serverId || localId` —— VoiceInfo 里 svr_id 缺失的老语音
 * 会落成 `<localId>.wav`（实测缓存目录里就有 `47.wav`），只认 serverId 会永远合流不进去。
 */
function cachedTranscriptOf(
  wxid: string,
  m: { serverId?: string; localId?: number }
): string | null {
  const sid = (m.serverId ?? '').trim()
  const lid = typeof m.localId === 'number' && m.localId > 0 ? String(m.localId) : ''
  for (const name of [sid ? `${sid}.wav` : '', lid ? `${lid}.wav` : '']) {
    if (!name) continue
    const text = readVoiceTranscript(wxid, name)
    if (text) return text
  }
  return null
}

/**
 * 给一批消息补上「已有的转写文本」：只处理 type 34 且侧存存在的情况。
 * 结果写进 parsedContent（形如 `[语音] 8″ 转写文本`）。
 */
export function decorateVoiceTranscripts<
  T extends {
    localType: number
    serverId?: string
    localId?: number
    parsedContent: string
    voiceDuration?: number
  }
>(messages: T[], wxid: string): T[] {
  if (!wxid || messages.length === 0) return messages
  for (const m of messages) {
    if (m.localType !== 34) continue
    if (m.parsedContent && !m.parsedContent.startsWith('[语音]')) continue
    const text = cachedTranscriptOf(wxid, m)
    if (!text) continue
    const seconds = m.voiceDuration ? Math.max(1, Math.round(m.voiceDuration / 1000)) : undefined
    m.parsedContent = composeVoiceContent(seconds, text)
  }
  return messages
}
