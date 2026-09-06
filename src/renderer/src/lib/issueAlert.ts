/**
 * 新问题提示音(问题监控):
 * - 监听主进程 issue:changed 推送,当 added>0(巡检/分析发现新问题)时播放一声提示音;
 * - 音效用 WebAudio 实时合成(无需音频素材),窗口内任意页面、是否聚焦均生效;
 * - 开关存 config `monitor.alertSound`(默认开),由 App 外壳 install 一次。
 */

const CFG_KEY = 'monitor.alertSound'
/** 同一声提示的最小间隔,避免多群并发巡检时连响 */
const MIN_GAP_MS = 10_000

let prefOn = true
let lastAt = 0
let ctx: AudioContext | null = null

function audioCtx(): AudioContext | null {
  try {
    if (!ctx) {
      const w = window as unknown as {
        AudioContext?: typeof AudioContext
        webkitAudioContext?: typeof AudioContext
      }
      const Ctor = w.AudioContext ?? w.webkitAudioContext
      if (!Ctor) return null
      ctx = new Ctor()
    }
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  } catch {
    return null
  }
}

/** 单音:正弦 + 音量包络(短促不刺耳) */
function tone(c: AudioContext, freq: number, at: number, dur: number, vol: number): void {
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'sine'
  osc.frequency.value = freq
  const t0 = c.currentTime + at
  gain.gain.setValueAtTime(0.0001, t0)
  gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.02)
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
  osc.connect(gain)
  gain.connect(c.destination)
  osc.start(t0)
  osc.stop(t0 + dur + 0.06)
}

/** 两段上行“叮-咚” */
function playChime(): void {
  const c = audioCtx()
  if (!c) return
  tone(c, 659, 0, 0.15, 0.13)
  tone(c, 988, 0.17, 0.32, 0.13)
}

/** 由 App 外壳安装一次:读偏好 + 订阅事件;返回取消订阅函数 */
export function installIssueAlertSound(): (() => void) | undefined {
  const cfg = window.api?.cs?.config
  const issueApi = window.api?.cs?.issue
  cfg
    ?.getAll()
    .then((all) => {
      prefOn = (all?.[CFG_KEY] ?? '1') !== '0'
    })
    .catch(() => undefined)
  if (!issueApi?.onChanged) return undefined
  return issueApi.onChanged((p) => {
    const added = p && typeof p.added === 'number' ? p.added : 0
    if (!prefOn || added <= 0) return
    const now = Date.now()
    if (now - lastAt < MIN_GAP_MS) return
    lastAt = now
    playChime()
  })
}

/** 设置页开关直接同步内存偏好(立即生效,无需等配置重读) */
export function setIssueAlertPref(on: boolean): void {
  prefOn = on
}
