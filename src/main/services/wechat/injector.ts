import { execFile } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import { app } from 'electron'
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
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath(),
      ...args
    ],
    { timeout: 30_000, windowsHide: true }
  )
  const lines = stdout.trim().split(/\r?\n/)
  const last = lines[lines.length - 1] ?? ''
  const start = last.indexOf('{')
  const end = last.lastIndexOf('}')
  if (start < 0 || end < 0) throw new Error(`注入脚本输出异常: ${stdout.slice(0, 200)}`)
  return JSON.parse(last.slice(start, end + 1)) as Record<string, unknown>
}

/** 查找并抢前台（诊断用） */
export async function focusWeChatWindow(): Promise<{ ok: boolean; title?: string; error?: string }> {
  try {
    const r = await runPs(['-Action', 'focus'])
    return {
      ok: !!r.ok,
      title: r.title as string | undefined,
      error: r.error as string | undefined
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 完整注入：搜索会话名 → 粘贴正文 → Enter 发送 */
export async function sendToChat(targetName: string, text: string): Promise<InjectResult> {
  // 会话名过长时截断（搜索框有长度限制）
  const target = targetName.length > 30 ? targetName.slice(0, 30) : targetName
  try {
    const r = await runPs(['-Action', 'send', '-Target', target, '-Text', text])
    return {
      ok: !!r.ok,
      error: r.error as string | undefined,
      sent: r.sent as boolean | undefined
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 手动注入开关（app_config: inject.enabled，默认开） */
export function injectEnabled(): boolean {
  return getConfig('inject.enabled') !== '0'
}
