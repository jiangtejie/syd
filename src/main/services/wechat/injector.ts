import { execFile } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import { app } from 'electron'
import { existsSync, statSync } from 'fs'
import { getConfig } from '../../db/repos/config'

/**
 * 微信桌面注入引擎（T8，方案 §4.2 发送层）。
 * 通过 PowerShell 调用 Win32 API（user32）：找窗口 → 抢前台 → Ctrl+F 搜索会话 →
 * 剪贴板粘贴正文 → Enter 发送。注入是全局独占资源，串行化由 sendService 队列保证。
 */

const execFileP = promisify(execFile)

export interface InjectResult {
  ok: boolean
  error?: string
  /** 是否已确认微信在前台完成注入 */
  sent?: boolean
}

function scriptPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'ps/wechat-inject.ps1')
    : join(app.getAppPath(), 'resources/ps/wechat-inject.ps1')
}

async function runPs(args: string[]): Promise<Record<string, unknown>> {
  const { stdout } = await execFileP(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath(), ...args],
    { timeout: 30_000, windowsHide: true }
  )
  const lines = stdout.trim().split(/\r?\n/)
  const last = lines[lines.length - 1] ?? ''
  const start = last.indexOf('{')
  const end = last.lastIndexOf('}')
  if (start < 0 || end < 0) throw new Error(`注入脚本输出异常: ${stdout.slice(0, 200)}`)
  return JSON.parse(last.slice(start, end + 1)) as Record<string, unknown>
}

/** 注入错误 → 可行动中文提示(脚本/异常信息对普通用户不友好) */
export function humanizeInjectError(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  if (/wechat window not found|window not found/i.test(raw)) {
    return '未检测到微信窗口:请先登录桌面微信并保持打开(最小化也可以),再重试发送'
  }
  if (/focus stolen/i.test(raw)) {
    return '微信窗口焦点被抢:发送期间请勿点击其它窗口或弹窗,稍后重试'
  }
  if (/clipboard busy/i.test(raw)) {
    return '系统剪贴板正被占用,请稍等几秒重试'
  }
  if (/multiple wechat windows/i.test(raw)) {
    return '检测到多个微信窗口:为避免发错人,请只保留要用的那个微信窗口后重试'
  }
  if (/file not found/i.test(raw)) {
    return '待发送的文件不存在或已被移动,请重新选择'
  }
  if (/timed out|timeout|timedout/i.test(raw)) {
    return '微信未在限时内响应:请确认微信窗口可输入(未锁屏/未卡死)后重试'
  }
  if (!/[\u4e00-\u9fa5]/.test(raw) && /failed to|exception|error|输出异常/i.test(raw)) {
    return `注入执行失败(${raw.slice(0, 90)})`
  }
  return undefined
}

/** 完整注入：搜索会话名 → 粘贴正文 → Enter 发送 */
export async function sendToChat(targetName: string, text: string): Promise<InjectResult> {
  // 会话名过长时截断（搜索框有长度限制）
  const target = targetName.length > 30 ? targetName.slice(0, 30) : targetName
  try {
    const r = await runPs(['-Action', 'send', '-Target', target, '-Text', text])
    const rawErr = r.error as string | undefined
    return {
      ok: !!r.ok,
      error: humanizeInjectError(rawErr) ?? rawErr,
      sent: r.sent as boolean | undefined
    }
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e)
    return { ok: false, error: humanizeInjectError(raw) ?? raw }
  }
}

/* ── 图片/文件发送 ── */

/** 单文件发送上限(微信对文件/图片的常规限制内留余量) */
const MAX_FILE_BYTES = 100 * 1024 * 1024
/** kind=image 时的可粘贴位图格式;webp 等无法经 System.Drawing 解码,自动按文件发送 */
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.webp'])

export interface SendFileResult extends InjectResult {
  /** true=按图片粘贴发送;false=按文件粘贴发送 */
  asImage?: boolean
}

/** 本地校验文件(存在/类型/大小),通过才发起注入 */
export function validateSendFile(path: string, kind: 'image' | 'file'): string | null {
  if (!path || !path.trim()) return '文件路径为空'
  const p = path.trim()
  if (!existsSync(p)) return '文件不存在或已被移动'
  const st = statSync(p)
  if (!st.isFile()) return '不是文件'
  if (st.size <= 0) return '文件为空'
  if (st.size > MAX_FILE_BYTES) return `文件超过 ${MAX_FILE_BYTES / 1024 / 1024}MB 上限`
  if (kind === 'image') {
    const ext = p.slice(p.lastIndexOf('.')).toLowerCase()
    if (!IMAGE_EXTS.has(ext)) return '不支持的图片格式(支持 png/jpg/jpeg/bmp/gif/webp)'
  }
  return null
}

/** 注入单个文件/图片:搜索会话 → 剪贴板(位图或文件列表) → Ctrl+V → Enter */
export async function sendFileToChat(
  targetName: string,
  path: string,
  kind: 'image' | 'file'
): Promise<SendFileResult> {
  const err = validateSendFile(path, kind)
  if (err) return { ok: false, error: err }
  const target = targetName.length > 30 ? targetName.slice(0, 30) : targetName
  try {
    const r = await runPs([
      '-Action',
      'sendfile',
      '-Target',
      target,
      '-Path',
      path,
      '-FileKind',
      kind
    ])
    return {
      ok: !!r.ok,
      error: humanizeInjectError(r.error as string | undefined) ?? (r.error as string | undefined),
      sent: r.sent as boolean | undefined,
      asImage: r.asImage === true
    }
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e)
    return { ok: false, error: humanizeInjectError(raw) ?? raw }
  }
}

/** 手动注入开关（app_config: inject.enabled，默认开） */
export function injectEnabled(): boolean {
  return getConfig('inject.enabled') !== '0'
}
