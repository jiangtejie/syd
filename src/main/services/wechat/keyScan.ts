import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { app } from 'electron'
import { verifyWxDbKey } from './decrypt'
import { locateWeChatDbs } from './dbLocator'
import { getConfig, getConfigNumber } from '../../db/repos/config'
import { nativeKeyScanStatus, nativeScanAccount } from './nativeKeyScan'
import { createLogger } from '../logging'
import {
  buildCmdLine,
  expandPlaceholders,
  extractKeyCandidates,
  needsCmdShim,
  parsePathList,
  splitArgs
} from './keyScanPure'

const keyLog = createLogger('wx-key-scan')

/**
 * 微信库密钥的「自动获取」——多来源 + 统一校验 + 明确降级。
 *
 * 现实约束：微信 4.x 的库密钥只存在于微信进程内存里，读内存需要原生组件（koffi + 自研 DLL + Ed25519 握手）。
 * 本项目作者自研的 `wechat_key_tool.dll` **随包分发**（见 nativeKeyScan.ts），作为第一顺位来源；
 * 另有三条「用户自备 / 本机发现」的来源兜底。**任何候选都必须先过 `verifyWxDbKey`（页 1 HMAC）才落库**：
 *
 * 0. nativeDll   —— 随包分发的原生组件（内存扫描，最省事）；
 * 1. component    —— 用户自备的已授权组件（<userData>/components/key-scan/index.cjs 导出 scan(ctx)）；
 * 2. externalTool —— 用户自备的命令行工具（如自写脚本 / 已授权的取 key CLI），约定「把 64 位十六进制打到
 *                    stdout 或 stderr」，支持 {{wxid}}/{{dbPath}}/{{dbStorage}} 占位符；
 * 3. localArtifacts —— 在指定搜索路径里找**已经被别的工具导出过**的密钥（txt/json/ini/log…），
 *                    这一步经常能直接命中，例如之前用别的工具导出的 key 文件。
 *
 * 为什么校验必须在我们这边：候选来源都不可信，页 1 HMAC 是唯一能确认「这个 key 真能开这个库」的判据。
 */

/** 组件目录：<userData>/components/key-scan */
export function keyScanComponentDir(): string {
  return join(app.getPath('userData'), 'components', 'key-scan')
}

export interface KeyScanContext {
  wxid: string
  dbPath: string
  dbStoragePath: string | null
  /** 校验候选：页 1 HMAC 通过才认（各来源都不需要懂我们的加密细节） */
  verify: (candidateHex: string) => boolean
}

export interface KeyScanComponent {
  scan: (ctx: KeyScanContext) => Promise<string | null> | string | null
}

export type KeyScanProviderId = 'nativeDll' | 'component' | 'externalTool' | 'localArtifacts'

export interface KeyScanAttempt {
  id: KeyScanProviderId
  label: string
  /** ok=找到并通过校验；candidates=有候选但都没过校验；empty=没找到候选；skipped/error=没跑或跑失败 */
  status: 'ok' | 'candidates' | 'empty' | 'skipped' | 'error'
  detail: string
}

export interface KeyScanResult {
  ok: boolean
  /** 通过校验的 64 位十六进制密钥（调用方负责落库） */
  key?: string
  provider?: KeyScanProviderId
  installed?: boolean
  error?: string
  attempts: KeyScanAttempt[]
}

/** 组件是否已安装（存在入口文件即视为已安装） */
export function isKeyScanComponentInstalled(): boolean {
  const entry = join(keyScanComponentDir(), 'index.cjs')
  try {
    return existsSync(entry) && statSync(entry).isFile()
  } catch {
    return false
  }
}

interface ProviderCtx {
  wxid: string
  dbPath: string
  dbStoragePath: string | null
  verify: (candidateHex: string) => boolean
  /** 依次校验候选，返回第一个通过的 */
  firstValid: (candidates: string[]) => string | null
}

type Provider = (ctx: ProviderCtx) => Promise<KeyScanAttempt>

/** 0) 随包分发的原生组件（自研 DLL）：能扫到就直接拿到 key，扫不到就往下走 */
const nativeDllProvider: Provider = async (ctx) => {
  const label = '原生组件'
  const status = nativeKeyScanStatus()
  if (!status.dllFound) {
    return {
      id: 'nativeDll',
      label,
      status: 'skipped',
      detail: `未随包找到 wechat_key_tool.dll（${status.dllPath}）`
    }
  }
  if (!status.koffiAvailable) {
    return {
      id: 'nativeDll',
      label,
      status: 'error',
      detail: 'koffi 不可用（原生 FFI 未安装或被裁剪）'
    }
  }
  if (!status.loaded && status.lastError) {
    return { id: 'nativeDll', label, status: 'error', detail: `组件加载失败: ${status.lastError}` }
  }
  const info = nativeScanAccount()
  const after = nativeKeyScanStatus()
  if (!info) {
    return {
      id: 'nativeDll',
      label,
      status: 'empty',
      detail: `组件已加载但没扫到密钥（${after.lastError ?? '未返回数据'}）`
    }
  }
  if (info.dbKey && ctx.verify(info.dbKey)) {
    return {
      id: 'nativeDll',
      label,
      status: 'ok',
      detail: `已通过页 1 校验（微信账号 ${info.wxid || info.name || '未知'}，耗时 ${after.lastMs ?? '?'}ms）`
    }
  }
  if (info.dbKey) {
    return {
      id: 'nativeDll',
      label,
      status: 'candidates',
      detail: '组件给出的密钥没通过页 1 校验（可能属于另一个账号或微信版本不匹配）'
    }
  }
  return {
    id: 'nativeDll',
    label,
    status: 'candidates',
    detail: `组件返回了账号信息但没有 db_key（wxid=${info.wxid || '未知'}）`
  }
}

/** 1) 可选组件 */
const componentProvider: Provider = async (ctx) => {
  const label = '可选组件'
  if (!isKeyScanComponentInstalled()) {
    return {
      id: 'component',
      label,
      status: 'skipped',
      detail: `未安装（可放到 ${keyScanComponentDir()}\\index.cjs，导出 scan(ctx)）`
    }
  }
  try {
    const entry = join(keyScanComponentDir(), 'index.cjs')
    // 先清 require 缓存：换掉组件文件后不必重启应用即可生效
    try {
      delete require.cache[require.resolve(entry)]
    } catch {
      /* 之前没加载过则无需清理 */
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- 组件是运行时可选加载的
    const mod = require(entry) as Partial<KeyScanComponent> & { default?: KeyScanComponent }
    const scan = mod.scan ?? mod.default?.scan
    if (typeof scan !== 'function') {
      return { id: 'component', label, status: 'error', detail: '组件入口没有导出 scan(ctx) 函数' }
    }
    const candidate = await scan({
      wxid: ctx.wxid,
      dbPath: ctx.dbPath,
      dbStoragePath: ctx.dbStoragePath,
      verify: ctx.verify
    })
    const list = extractKeyCandidates(typeof candidate === 'string' ? candidate : '')
    if (list.length === 0) {
      return { id: 'component', label, status: 'empty', detail: '组件没给出有效密钥' }
    }
    const hit = ctx.firstValid(list)
    return hit
      ? { id: 'component', label, status: 'ok', detail: '组件返回的密钥已通过页 1 校验' }
      : {
          id: 'component',
          label,
          status: 'candidates',
          detail: '组件给出的密钥没通过页 1 校验，已丢弃'
        }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    keyLog.warn(`组件执行失败: ${msg}`)
    return { id: 'component', label, status: 'error', detail: `组件执行失败: ${msg}` }
  }
}

/** 2) 外部工具（用户自备 CLI）：stdout/stderr 里找 64 位十六进制 */
const externalToolProvider: Provider = async (ctx) => {
  const label = '外部工具'
  const command = (getConfig('wechat.keyTool.command') ?? '').trim()
  if (!command) {
    return {
      id: 'externalTool',
      label,
      status: 'skipped',
      detail: '未配置（设置里可填一个已授权的取 key 命令）'
    }
  }
  if (!existsSync(command)) {
    return { id: 'externalTool', label, status: 'error', detail: `命令不存在: ${command}` }
  }
  const vars = { wxid: ctx.wxid, dbPath: ctx.dbPath, dbStorage: ctx.dbStoragePath ?? '' }
  const args = splitArgs(expandPlaceholders(getConfig('wechat.keyTool.args') ?? '', vars))
  const timeout = Math.max(3000, getConfigNumber('wechat.keyTool.timeoutMs', 30_000))
  // .cmd/.bat 必须经 cmd.exe 解释（execFile 直接跑会 EINVAL）；参数按 Windows 规则转义后整条传入
  const useShim = needsCmdShim(command)
  const spawnTarget = useShim ? process.env.ComSpec || 'cmd.exe' : command
  const spawnArgs = useShim ? ['/d', '/s', '/c', buildCmdLine(command, args)] : args
  const run = (): Promise<{ stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      execFile(
        spawnTarget,
        spawnArgs,
        {
          timeout,
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true,
          windowsVerbatimArguments: useShim
        },
        (err, so, se) => {
          if (err && !so && !se) {
            reject(new Error(err.message))
            return
          }
          resolve({ stdout: String(so ?? ''), stderr: String(se ?? '') })
        }
      )
    })
  try {
    const { stdout, stderr } = await run()
    const candidates = extractKeyCandidates(`${stdout}\n${stderr}`)
    if (candidates.length === 0) {
      return {
        id: 'externalTool',
        label,
        status: 'empty',
        detail: '命令执行了，但输出里没有 64 位十六进制密钥'
      }
    }
    const hit = ctx.firstValid(candidates)
    return hit
      ? { id: 'externalTool', label, status: 'ok', detail: '工具输出的密钥已通过页 1 校验' }
      : {
          id: 'externalTool',
          label,
          status: 'candidates',
          detail: `输出里有 ${candidates.length} 个候选，但都没通过页 1 校验`
        }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { id: 'externalTool', label, status: 'error', detail: `执行失败: ${msg}` }
  }
}

/** 可扫描的文本类文件扩展名（避免把图片/视频读进来） */
const TEXT_EXT = new Set([
  '.txt',
  '.json',
  '.ini',
  '.cfg',
  '.conf',
  '.log',
  '.md',
  '.csv',
  '.key',
  '.dat',
  '.yaml',
  '.yml'
])
/** 单文件大小上限与目录深度上限（防止扫到大文件/深层目录） */
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_DEPTH = 4
const MAX_FILES = 400

/** 收集搜索路径下的候选文件（有界：深度/文件数/大小都设上限） */
function collectFiles(roots: string[]): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (out.length >= MAX_FILES || depth > MAX_DEPTH) return
    let entries: import('node:fs').Dirent[] = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (!e.isFile()) continue
      if (!TEXT_EXT.has(extname(e.name).toLowerCase())) continue
      try {
        if (statSync(full).size > MAX_FILE_BYTES) continue
      } catch {
        continue
      }
      out.push(full)
    }
  }
  for (const r of roots) {
    try {
      if (existsSync(r)) walk(r, 0)
    } catch {
      /* 单个路径失败不影响其它 */
    }
  }
  return out
}

/** 3) 本地已导出的密钥文件（别的工具 dump 出来的 key 常在这里） */
const localArtifactsProvider: Provider = async (ctx) => {
  const label = '本地文件'
  const configured = parsePathList(getConfig('wechat.keySearchPaths') ?? '')
  const roots = configured.length > 0 ? configured : defaultSearchPaths(ctx)
  const files = collectFiles(roots)
  if (files.length === 0) {
    return {
      id: 'localArtifacts',
      label,
      status: 'empty',
      detail: `在 ${roots.length} 个路径下没找到可扫描的文本文件`
    }
  }
  const candidates: string[] = []
  for (const f of files) {
    try {
      const text = readFileSync(f, 'utf8')
      for (const c of extractKeyCandidates(text, 5)) {
        if (!candidates.includes(c)) candidates.push(c)
        if (candidates.length >= 20) break
      }
    } catch {
      /* 编码/权限问题：跳过 */
    }
    if (candidates.length >= 20) break
  }
  if (candidates.length === 0) {
    return {
      id: 'localArtifacts',
      label,
      status: 'empty',
      detail: `扫了 ${files.length} 个文件，没有 64 位十六进制密钥`
    }
  }
  const hit = ctx.firstValid(candidates)
  return hit
    ? { id: 'localArtifacts', label, status: 'ok', detail: `在本地文件里找到并通过校验` }
    : {
        id: 'localArtifacts',
        label,
        status: 'candidates',
        detail: `扫了 ${files.length} 个文件、${candidates.length} 个候选，都没通过页 1 校验`
      }
}

/** 默认搜索路径：应用数据目录 + 微信数据根 + 账号目录（都是「可能被工具写过 key」的地方） */
function defaultSearchPaths(ctx: ProviderCtx): string[] {
  const paths = [app.getPath('userData')]
  if (ctx.dbPath) paths.push(ctx.dbPath)
  if (ctx.dbStoragePath) paths.push(ctx.dbStoragePath)
  return paths
}

const PROVIDERS: Provider[] = [
  nativeDllProvider,
  componentProvider,
  externalToolProvider,
  localArtifactsProvider
]

/**
 * 依次尝试各来源，返回第一个**通过页 1 校验**的密钥，并带上每个来源的结果（界面照实展示）。
 * 任何异常都收敛成 attempt 明细，不抛给 IPC。
 */
export async function scanWeChatKey(opts: {
  wxid: string
  dbPath?: string
  /** 只跑指定来源（自检/诊断用） */
  only?: KeyScanProviderId[]
}): Promise<KeyScanResult> {
  const attempts: KeyScanAttempt[] = []
  const wxid = (opts.wxid ?? '').trim()
  if (!wxid) return { ok: false, error: '缺少账号', attempts }

  const paths = locateWeChatDbs(opts.dbPath ?? '', wxid)
  const anyDb = paths.msgDbFiles[0] ?? paths.sessionDbFile ?? null
  if (!anyDb) {
    return {
      ok: false,
      error: '没定位到微信库文件，先填对「微信数据根目录」再试',
      installed: isKeyScanComponentInstalled(),
      attempts
    }
  }
  const verified = new Set<string>()
  const ctx: ProviderCtx = {
    wxid,
    dbPath: opts.dbPath ?? '',
    dbStoragePath: paths.dbStoragePath,
    verify: (candidateHex) => {
      if (verified.has(candidateHex)) return true
      const r = verifyWxDbKey(anyDb, candidateHex)
      if (r.ok) verified.add(candidateHex)
      return r.ok
    },
    firstValid: (candidates) => candidates.find((c) => ctx.verify(c)) ?? null
  }

  const list = opts.only?.length
    ? PROVIDERS.filter((p) => {
        const id = providerIdOf(p)
        return id ? opts.only!.includes(id) : false
      })
    : PROVIDERS

  for (const provider of list) {
    const id = providerIdOf(provider)
    let attempt: KeyScanAttempt
    try {
      attempt = await provider(ctx)
    } catch (err) {
      attempt = {
        id: id ?? 'component',
        label: '未知来源',
        status: 'error',
        detail: err instanceof Error ? err.message : String(err)
      }
    }
    attempts.push(attempt)
    if (attempt.status === 'ok') {
      const hit = [...verified][0]
      return {
        ok: true,
        key: hit,
        provider: attempt.id,
        installed: isKeyScanComponentInstalled(),
        attempts
      }
    }
  }

  const hints = attempts
    .filter((a) => a.status !== 'ok')
    .map((a) => `${a.label}: ${a.detail}`)
    .join('；')
  return {
    ok: false,
    installed: isKeyScanComponentInstalled(),
    error: `各来源都没拿到可用密钥 —— ${hints}。最稳妥的办法仍是手动导入 64 位十六进制密钥。`,
    attempts
  }
}

/** 从 provider 函数反查 id（避免每个函数都重复声明） */
function providerIdOf(provider: Provider): KeyScanProviderId | null {
  if (provider === nativeDllProvider) return 'nativeDll'
  if (provider === componentProvider) return 'component'
  if (provider === externalToolProvider) return 'externalTool'
  if (provider === localArtifactsProvider) return 'localArtifacts'
  return null
}
