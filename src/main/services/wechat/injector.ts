import { execFile } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import { app } from 'electron'
import { existsSync, statSync, writeFileSync, rmSync, mkdirSync } from 'fs'
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
  /** 实际打开的会话标题(OCR 读回,用于审计与排查) */
  opened?: string
}

/**
 * 打开会话时的判定依据(传给 wechat-inject.ps1 的 -NamesFile / -IsGroup):
 * 微信 4.x 是自绘界面(UI Automation 只有一个 MMUIRender 表面),搜索结果第一行
 * 永远是「搜索网络结果」而不是群聊,所以脚本改成截图 + 系统 OCR 定位结果行并点击,
 * 读完会话标题确认无误才输入。names 是会话列表的全部展示名,用来判断「刚打开的
 * 会话」是不是目标——比目标更接近别的会话名时直接中止,一个字都不输入。
 */
export interface InjectContext {
  names?: string[]
  /** 目标是群聊(sessionId 以 @chatroom 结尾):决定在搜索结果的哪个区块里找 */
  isGroup?: boolean
}

/** 注入过程截图(最近一次)落盘位置:排查时可直接看微信当时显示了什么 */
function shotDir(): string {
  const dir = join(app.getPath('userData'), 'inject-shots')
  try {
    mkdirSync(dir, { recursive: true })
    return dir
  } catch {
    return app.getPath('temp')
  }
}

/** 会话名清单(一行一个,UTF-8)交给 PS 侧做最近邻校验;用完即删 */
function writeNamesFile(names: string[] | undefined): string | null {
  if (!names || names.length === 0) return null
  try {
    const p = join(app.getPath('temp'), 'wx-names-' + process.pid + '-' + Date.now() + '.txt')
    writeFileSync(p, names.slice(0, 5000).join('\n'), 'utf8')
    return p
  } catch {
    return null
  }
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
    // 脚本只在「真的多开」(多个微信进程各有一个主窗口)时返回,并带上实例明细:
    // "Multiple WeChat windows found: 2 instances (pid 1 微信; pid 2 微信)"
    const detail = raw.match(/multiple wechat windows[^(]*\(([^)]*)\)/i)?.[1]?.trim()
    const which = detail ? `(${detail})` : ''
    return `检测到多个微信实例${which}:为避免发错群,请退出多余的微信(只保留一个)后重试`
  }
  if (/wrong chat opened/i.test(raw)) {
    // 脚本 OCR 读回的会话标题与原目标不符时中止,此时一个字都没输入
    const m = raw.match(/header reads "([^"]*)"/i)
    const which = m?.[1]?.trim()
    return which
      ? '打开的会话不是目标会话(实际打开:' + which + '):已中止,未发出任何内容'
      : '打开的会话不是目标会话:已中止,未发出任何内容'
  }
  if (/target row not found in search results/i.test(raw)) {
    return '未在微信搜索结果里找到该会话:请确认群名/备注是否正确、微信窗口能正常操作后重试'
  }
  if (/search box did not open/i.test(raw)) {
    return '微信搜索框没能打开:请确认微信窗口没有被遮挡或卡住,稍后重试'
  }
  if (/ocr unavailable/i.test(raw)) {
    return '系统缺少中文 OCR 组件:设置 → 时间和语言 → 语言和区域 → 中文(简体) → 语言选项 → 可选功能里安装「光学字符识别」后重试'
  }
  if (/screenshot failed|ocr failed/i.test(raw)) {
    return '微信窗口截图/识别失败:请让微信窗口保持可见(不要被其它窗口盖住)后重试'
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

/** 搜索会话名 → 打开(OCR 定位+点击+标题校验) → 粘贴正文 → Enter */
export async function sendToChat(
  targetName: string,
  text: string,
  ctx: InjectContext = {}
): Promise<InjectResult> {
  // 会话名过长时截断（搜索框有长度限制）
  const target = targetName.length > 30 ? targetName.slice(0, 30) : targetName
  const namesFile = writeNamesFile(ctx.names)
  try {
    const args = [
      '-Action',
      'send',
      '-Target',
      target,
      '-Text',
      text,
      '-IsGroup',
      ctx.isGroup === false ? '0' : '1',
      '-ShotDir',
      shotDir()
    ]
    if (namesFile) args.push('-NamesFile', namesFile)
    const r = await runPs(args)
    const rawErr = r.error as string | undefined
    return {
      ok: !!r.ok,
      error: humanizeInjectError(rawErr) ?? rawErr,
      sent: r.sent as boolean | undefined,
      opened: r.opened as string | undefined
    }
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e)
    return { ok: false, error: humanizeInjectError(raw) ?? raw }
  } finally {
    if (namesFile) {
      try {
        rmSync(namesFile, { force: true })
      } catch {
        /* 临时文件删不掉不影响发送 */
      }
    }
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

/** 注入单个文件/图片:打开会话(OCR 校验) → 剪贴板(位图或文件列表) → Ctrl+V → Enter */
export async function sendFileToChat(
  targetName: string,
  path: string,
  kind: 'image' | 'file',
  ctx: InjectContext = {}
): Promise<SendFileResult> {
  const err = validateSendFile(path, kind)
  if (err) return { ok: false, error: err }
  const target = targetName.length > 30 ? targetName.slice(0, 30) : targetName
  const namesFile = writeNamesFile(ctx.names)
  try {
    const args = [
      '-Action',
      'sendfile',
      '-Target',
      target,
      '-Path',
      path,
      '-FileKind',
      kind,
      '-IsGroup',
      ctx.isGroup === false ? '0' : '1',
      '-ShotDir',
      shotDir()
    ]
    if (namesFile) args.push('-NamesFile', namesFile)
    const r = await runPs(args)
    return {
      ok: !!r.ok,
      error: humanizeInjectError(r.error as string | undefined) ?? (r.error as string | undefined),
      sent: r.sent as boolean | undefined,
      asImage: r.asImage === true,
      opened: r.opened as string | undefined
    }
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e)
    return { ok: false, error: humanizeInjectError(raw) ?? raw }
  } finally {
    if (namesFile) {
      try {
        rmSync(namesFile, { force: true })
      } catch {
        /* 临时文件删不掉不影响发送 */
      }
    }
  }
}

/** 手动注入开关（app_config: inject.enabled，默认开） */
export function injectEnabled(): boolean {
  return getConfig('inject.enabled') !== '0'
}
