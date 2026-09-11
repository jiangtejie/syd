/**
 * ct-media URL 的路径解析（纯函数，便于自检）。
 *
 * 协议布局两种：
 *   <wxid>/<资源名>            图片/视频产物（<md5>_<kind>.<ext>）
 *   <wxid>/voices/<id>.wav     语音产物（SILK 解码缓存）
 *
 * 单独拆出来是因为这里出过一次真实事故：语音 URL 早期把 `voices/xxx.wav` 整体做了
 * encodeURIComponent，于是 `/` 变成 `%2F`、整条路径只剩两段，被协议判成「非法资源名 403」——
 * 渲染端只会看到一个加载失败，没有任何线索。把「段」与「命名」的判定固化成可测函数后，
 * 这类错误在自检里就能拦住。
 */

/** 图片/视频产物命名：<md5>_<kind>.<ext> */
export const MEDIA_ASSET_NAME_RE =
  /^[0-9a-f]{32}_[a-z0-9]+\.(jpe?g|png|gif|webp|mp4|mkv|avi|mov|m4v)$/i
/** 语音产物命名：<数字 id>.wav */
export const MEDIA_VOICE_NAME_RE = /^\d{1,20}\.wav$/
/** wxid 只允许常规字符（不允许路径分隔与冒号） */
export const WXID_RE = /^[a-zA-Z0-9_@.-]+$/

/** media 协议 URL 前缀（与主进程 protocol.handle('ct-media') 约定一致） */
export const MEDIA_URL_BASE = 'ct-media://media'

/** 图片/视频产物 URL：ct-media://media/<wxid>/<文件名> */
export function toMediaUrl(wxid: string, fileName: string): string {
  return `${MEDIA_URL_BASE}/${encodeURIComponent(wxid)}/${encodeURIComponent(fileName)}`
}

/**
 * 语音产物 URL：ct-media://media/<wxid>/voices/<file>。
 * 注意不要把 `voices/<file>` 整体编码 —— `/` 会变成 %2F、路径只剩两段，协议侧按段解析会直接 403。
 */
export function toVoiceMediaUrl(wxid: string, fileName: string): string {
  return `${MEDIA_URL_BASE}/${encodeURIComponent(wxid)}/voices/${encodeURIComponent(fileName)}`
}

export interface MediaPathHit {
  kind: 'asset' | 'voice'
  /** URL 里的账号段（已解码） */
  wxid: string
  /** 相对 `<mediaRoot>/<wxid>` 的路径片段（已解码，用于 resolve） */
  rel: string[]
}

/**
 * 解析 ct-media URL 的 pathname。返回 null 表示不合法（调用方按 403/404 处理）。
 * `badShape` 区分「段数不对」（404）与「命名不合规」（403）。
 */
export function parseMediaPath(pathname: string): { hit: MediaPathHit | null; badShape: boolean } {
  const seg = (pathname || '').split('/').filter(Boolean).map(safeDecode)
  const isAsset = seg.length === 2 && MEDIA_ASSET_NAME_RE.test(seg[1])
  const isVoice = seg.length === 3 && seg[1] === 'voices' && MEDIA_VOICE_NAME_RE.test(seg[2])
  if (!isAsset && !isVoice) {
    return { hit: null, badShape: seg.length !== 2 && seg.length !== 3 }
  }
  const wxid = seg[0]
  if (!WXID_RE.test(wxid)) return { hit: null, badShape: false }
  return {
    hit: isVoice
      ? { kind: 'voice', wxid, rel: ['voices', seg[2]] }
      : { kind: 'asset', wxid, rel: [seg[1]] },
    badShape: false
  }
}

/** decodeURIComponent 会对孤立的 % 抛错，这里降级为原串（后续校验会拦住它） */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}
