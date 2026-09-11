import { existsSync } from 'node:fs'
import { createPrivateKey, sign, type KeyObject } from 'node:crypto'
import { app } from 'electron'
import { join } from 'node:path'
import { createLogger } from '../logging'

const log = createLogger('wx-native-key')

/**
 * 原生取 key 组件（`wechat_key_tool.dll`，**随包分发**，由本项目作者自研/授权）。
 *
 * 能力：挑战-应答（Ed25519）+ 内存扫描，取当前登录微信的库密钥；另有图片 AES key 扫描。
 * 与其它来源一样，**返回值只当作不可信文本**：最终仍要过 `verifyWxDbKey`（页 1 HMAC）才落库。
 *
 * 为什么不直接用他们的 JS 封装：我们的运行环境是 Electron 主进程 + 打包后 asar，
 * DLL 路径、koffi 加载时机、失败降级都要按我们的方式处理；这里只复刻其调用约定：
 *   wkt_challenge(uint8_t*, size_t) -> int            // 32 字节 nonce
 *   wkt_scan_account_auth(uint8_t*, size_t) -> char*  // Ed25519 签名 → JSON 字符串
 *   wkt_scan_image_key_auth(uint8_t*, size_t, uint8_t*, size_t) -> char*
 *   wkt_free(void*)
 * 私钥是 XOR 0x5a 混淆的 PKCS8 DER（与组件发布方约定，需与 DLL 版本配套）。
 */

const OBFUSCATED_PRIVATE_KEY =
  '6a74585b5a6a5f5c59713f2a5e785e7a168e0e9425838c437f0b1274d114f59457f436c936b80178da1848856b58eef3'

export interface NativeScanAccount {
  dbKey: string | null
  wxid: string
  name: string
  number: string
  phone: string
  seed: number
}

export interface NativeScanDiagnostics {
  /** 组件目录（打包后在 resources 下） */
  dir: string
  dllPath: string
  dllFound: boolean
  /** koffi 是否可用（离线构建下缺失时优雅降级） */
  koffiAvailable: boolean
  loaded: boolean
  /** 最近一次调用的耗时：认证通过才会真正扫描（被拒会瞬时返回） */
  lastMs: number | null
  lastError: string | null
}

const lastDiag: Omit<NativeScanDiagnostics, 'dir' | 'dllPath' | 'dllFound' | 'koffiAvailable'> = {
  loaded: false,
  lastMs: null,
  lastError: null
}

/** 组件目录：dev 走仓库 resources，打包后走 <resources>/wechat-key-tool */
export function nativeToolDir(): string {
  const packaged = join(process.resourcesPath ?? '', 'wechat-key-tool')
  if (existsSync(join(packaged, 'wechat_key_tool.dll'))) return packaged
  return join(app.getAppPath(), 'resources', 'wechat-key-tool')
}

export function nativeDllPath(): string {
  return join(nativeToolDir(), 'wechat_key_tool.dll')
}

interface KoffiLib {
  func: (signature: string) => (...args: unknown[]) => unknown
}

interface KoffiModule {
  load: (path: string) => KoffiLib
  decode: (ptr: unknown, type: string, len: number) => string
}

let koffiModule: KoffiModule | null | undefined

/** 懒加载 koffi：缺失时返回 null（离线/精简安装不该让主进程起不来） */
function getKoffi(): KoffiModule | null {
  if (koffiModule !== undefined) return koffiModule
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- 原生 FFI 仅在需要时加载
    koffiModule = require('koffi') as KoffiModule
  } catch (e) {
    log.warn(`koffi 不可用，原生取 key 组件已跳过: ${e instanceof Error ? e.message : String(e)}`)
    koffiModule = null
  }
  return koffiModule
}

function scanPrivateKey(): KeyObject {
  const der = Buffer.from(Buffer.from(OBFUSCATED_PRIVATE_KEY, 'hex').map((v) => v ^ 0x5a))
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
}

interface NativeApi {
  challenge: (buf: Buffer, len: number) => number
  scanAccount: (sig: Buffer, len: number) => unknown
  scanImage: (sig: Buffer, len: number, data: Buffer, dataLen: number) => unknown
  free: (ptr: unknown) => void
  decode: (ptr: unknown) => string
}

let api: NativeApi | null = null

function loadApi(): NativeApi | null {
  if (api) return api
  const koffi = getKoffi()
  const dll = nativeDllPath()
  if (!koffi || !existsSync(dll)) return null
  try {
    const lib = koffi.load(dll)
    api = {
      challenge: lib.func('int wkt_challenge(uint8_t*, size_t)') as NativeApi['challenge'],
      scanAccount: lib.func(
        'void* wkt_scan_account_auth(uint8_t*, size_t)'
      ) as NativeApi['scanAccount'],
      scanImage: lib.func(
        'void* wkt_scan_image_key_auth(uint8_t*, size_t, uint8_t*, size_t)'
      ) as NativeApi['scanImage'],
      free: lib.func('void wkt_free(void*)') as NativeApi['free'],
      decode: (ptr: unknown) =>
        String(koffi.decode(ptr, 'char', -1) || '')
          .replace(/\0/g, '')
          .trim()
    }
    lastDiag.loaded = true
    lastDiag.lastError = null
    return api
  } catch (e) {
    lastDiag.lastError = e instanceof Error ? e.message : String(e)
    log.warn(`原生组件加载失败: ${lastDiag.lastError}`)
    return null
  }
}

/** 挑战-应答：拿到签名（认证失败时 DLL 会瞬时返回空指针，用耗时区分「认证被拒」与「扫不到」） */
function signedChallenge(): Buffer | null {
  const inst = loadApi()
  if (!inst) return null
  const nonce = Buffer.alloc(32)
  if (inst.challenge(nonce, 32) !== 32) {
    lastDiag.lastError = 'wkt_challenge 未返回 32 字节 nonce'
    return null
  }
  return sign(null, nonce, scanPrivateKey())
}

/** 扫描当前登录微信的账号信息（含 db_key）；失败返回 null */
export function nativeScanAccount(): NativeScanAccount | null {
  const sig = signedChallenge()
  if (!sig) return null
  const inst = loadApi()
  if (!inst) return null
  const started = Date.now()
  try {
    const ptr = inst.scanAccount(sig, sig.length)
    lastDiag.lastMs = Date.now() - started
    if (!ptr) {
      lastDiag.lastError = `组件返回空（认证通过时为「未扫到」，耗时 ${lastDiag.lastMs}ms）`
      return null
    }
    const text = inst.decode(ptr)
    inst.free(ptr)
    const data = JSON.parse(text) as Record<string, unknown>
    const dbKey = typeof data.db_key === 'string' ? data.db_key.trim().toLowerCase() : ''
    lastDiag.lastError = null
    return {
      dbKey: dbKey.length === 64 ? dbKey : null,
      wxid: String(data.wxid ?? '').trim(),
      // 组件把微信 ID 别名叫 name、昵称叫 number（与上游约定一致，这里换回常规字段）
      name: String(data.number ?? '').trim(),
      number: String(data.name ?? '').trim(),
      phone: String(data.phone ?? '').trim(),
      seed: Number(data.seed) || 0
    }
  } catch (e) {
    lastDiag.lastMs = Date.now() - started
    lastDiag.lastError = e instanceof Error ? e.message : String(e)
    log.warn(`原生取 key 失败: ${lastDiag.lastError}`)
    return null
  }
}

/** 图片 AES key 扫描（用一段真实密文做探测）；失败返回 null */
export function nativeScanImageKey(ciphertext: Buffer): string | null {
  if (!ciphertext || ciphertext.length < 16) return null
  const sig = signedChallenge()
  const inst = sig ? loadApi() : null
  if (!sig || !inst) return null
  try {
    const probe = ciphertext.subarray(0, Math.min(ciphertext.length, 4096))
    const ptr = inst.scanImage(sig, sig.length, probe, probe.length)
    if (!ptr) return null
    const text = inst.decode(ptr)
    inst.free(ptr)
    const key = text.trim().toLowerCase().replace(/^0x/, '')
    return key.length >= 16 ? key : null
  } catch (e) {
    lastDiag.lastError = e instanceof Error ? e.message : String(e)
    return null
  }
}

/** 组件状态（体检与界面展示用）：文件在不在、koffi 能不能加载、上次调用发生了什么 */
export function nativeKeyScanStatus(): NativeScanDiagnostics {
  const dir = nativeToolDir()
  const dllPath = join(dir, 'wechat_key_tool.dll')
  const koffi = getKoffi()
  return {
    dir,
    dllPath,
    dllFound: existsSync(dllPath),
    koffiAvailable: !!koffi,
    ...lastDiag
  }
}
/* ── 环境诊断：组件需要「加载了 weixin.dll 的那个微信进程」 ── */

export interface WeixinProcessInfo {
  pid: number
  mb: number
  modules: number
  /** 该进程是否加载了 weixin.dll（组件的内存扫描前提） */
  hasWeixinDll: boolean
  /** 加载到的 weixin.dll 版本（4.x 的核心版本在这里，不是 Weixin.exe 的资源版本） */
  wxDllVersion: string | null
  wxDllPath: string | null
}

let procCache: { at: number; list: WeixinProcessInfo[] } | null = null

/**
 * 列出 Weixin 进程及各自的 weixin.dll 加载情况。
 *
 * 为什么要这一步：组件的字符串里有 `weixin.dll` + `module not found`，用的是
 * CreateToolhelp32Snapshot/Module32FirstW + ReadProcessMemory —— 也就是说它**必须挑到那个加载了
 * weixin.dll 的进程**。实测本机 5 个 Weixin 进程里只有 1 个加载了它（其余是子进程/辅助进程），
 * 挑错就只会拿到空结果。这里把这份环境事实暴露出来，便于定位「组件为什么扫不到」。
 */
export function weixinProcesses(force = false): WeixinProcessInfo[] {
  const now = Date.now()
  if (!force && procCache && now - procCache.at < 10_000) return procCache.list
  const script =
    "Get-Process -Name Weixin -ErrorAction SilentlyContinue | ForEach-Object { " +
    "$m=$null; try{$m=$_.Modules|Where-Object{$_.ModuleName -ieq 'weixin.dll'}|Select-Object -First 1}catch{}; " +
    "$c=0; try{$c=$_.Modules.Count}catch{}; " +
    "[pscustomobject]@{pid=$_.Id;mb=[math]::Round($_.WorkingSet64/1MB);modules=$c;" +
    "ver=$(if($m){$m.FileVersionInfo.FileVersion}else{''});path=$(if($m){$m.FileName}else{''})} } | ConvertTo-Json -Compress"
  let raw = ''
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- 只在诊断时按需调用
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
    raw = String(
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        timeout: 8000,
        windowsHide: true,
        encoding: 'utf8'
      }) ?? ''
    ).trim()
  } catch (e) {
    lastDiag.lastError = `进程枚举失败: ${e instanceof Error ? e.message : String(e)}`
    return []
  }
  let list: WeixinProcessInfo[] = []
  try {
    const parsed = JSON.parse(raw || '[]') as
      | Record<string, unknown>
      | Array<Record<string, unknown>>
    list = (Array.isArray(parsed) ? parsed : [parsed]).map((r) => ({
      pid: Number(r.pid) || 0,
      mb: Number(r.mb) || 0,
      modules: Number(r.modules) || 0,
      hasWeixinDll: !!String(r.ver ?? '').trim(),
      wxDllVersion: String(r.ver ?? '').trim() || null,
      wxDllPath: String(r.path ?? '').trim() || null
    }))
  } catch {
    list = []
  }
  procCache = { at: now, list }
  return list
}

/** 组件运行环境摘要（体检/失败原因里展示） */
export function nativeScanEnvironment(): {
  processes: WeixinProcessInfo[]
  withDll: WeixinProcessInfo[]
  hint: string
} {
  const processes = weixinProcesses()
  const withDll = processes.filter((x) => x.hasWeixinDll)
  let hint = '未发现 Weixin 进程（微信可能没在运行）'
  if (processes.length > 0 && withDll.length === 0) {
    hint = `${processes.length} 个 Weixin 进程都没有加载 weixin.dll（组件的内存扫描前提）`
  } else if (withDll.length > 0) {
    hint =
      `${processes.length} 个 Weixin 进程中 ${withDll.length} 个加载了 weixin.dll ` +
      `${withDll[0].wxDllVersion ?? '未知版本'}（pid ${withDll.map((x) => x.pid).join(',')}）`
  }
  return { processes, withDll, hint }
}
