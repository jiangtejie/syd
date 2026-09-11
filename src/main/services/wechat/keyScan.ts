import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { getConfig, getConfigNumber } from '../../db/repos/config'
import { verifyWxDbKey } from './decrypt'
import { locateWeChatDbs } from './dbLocator'
import { createLogger } from '../logging'
import { nativeKeyScanStatus, nativeScanAccount } from './nativeKeyScan'
import {
  buildCmdLine,
  expandPlaceholders,
  extractKeyCandidates,
  needsCmdShim,
  splitArgs
} from './keyScanPure'

const keyLog = createLogger('wx-key-scan')

/**
 * 微信库密钥的「自动获取」——两个来源 + 统一校验 + 明确降级。
 *
 * 1. nativeDll   —— 随包分发的原生组件（作者自研 `wechat_key_tool.dll`）：内存扫描 + Ed25519 挑战-应答，
 *                   能扫到就直接拿到 key（最省事的一步）；
 * 2. externalTool —— 兜底：用户自备的命令行工具（自写脚本 / 已授权 CLI），约定「把 64 位十六进制打到
 *                   stdout 或 stderr」，支持 {{wxid}}/{{dbPath}}/{{dbStorage}} 占位符，`.cmd/.bat` 自动经
 *                   cmd.exe 包装；此外设置页还支持直接**粘贴**密钥（走 onboard）。
 *
 * **唯一安全边界**：两个来源的返回都只当作不可信文本，必须先过 `verifyWxDbKey`（页 1 HMAC）才落库。
 *
 * 曾经的第三条/第四条来源（自备组件协议、扫本机文件找密钥、第三方工具预设）已按审核结论移除：
 * 前两条与「原生 DLL / 粘贴 / 外部工具」重叠且是多余的可执行面与可疑行为，第三方工具的参数只能靠猜。
 */

export type KeyScanProviderId = 'nativeDll' | 'externalTool'

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
  error?: string
  attempts: KeyScanAttempt[]
}

interface ProviderCtx {
  wxid: string
  dbPath: string
  dbStoragePath: string | null
  /** 校验候选：页 1 HMAC 通过才认 */
  verify: (candidateHex: string) => boolean
  /** 依次校验候选，返回第一个通过的 */
  firstValid: (candidates: string[]) => string | null
}

type Provider = (ctx: ProviderCtx) => Promise<KeyScanAttempt>

/** 1) 随包分发的原生组件（自研 DLL）：扫不到就往下走 */
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

/** 2) 外部工具（用户自备 CLI）：stdout/stderr 里找 64 位十六进制 */
const externalToolProvider: Provider = async (ctx) => {
  const label = '外部工具'
  const command = (getConfig('wechat.keyTool.command') ?? '').trim()
  if (!command) {
    return {
      id: 'externalTool',
      label,
      status: 'skipped',
      detail: '未配置（设置里可填一个取 key 命令）'
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

const PROVIDERS: Provider[] = [nativeDllProvider, externalToolProvider]

/**
 * 依次尝试两个来源，返回第一个**通过页 1 校验**的密钥，并带上每个来源的结果（界面照实展示）。
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
        id: id ?? 'externalTool',
        label: '未知来源',
        status: 'error',
        detail: err instanceof Error ? err.message : String(err)
      }
    }
    attempts.push(attempt)
    if (attempt.status === 'ok') {
      const hit = [...verified][0]
      keyLog.info(`密钥自动获取成功（来源 ${attempt.id}）`)
      return { ok: true, key: hit, provider: attempt.id, attempts }
    }
  }

  const hints = attempts.map((a) => `${a.label}: ${a.detail}`).join('；')
  return {
    ok: false,
    error: `各来源都没拿到可用密钥 —— ${hints}。也可以在设置里直接粘贴 64 位十六进制密钥。`,
    attempts
  }
}

/** 从 provider 函数反查 id（避免每个函数都重复声明） */
function providerIdOf(provider: Provider): KeyScanProviderId | null {
  if (provider === nativeDllProvider) return 'nativeDll'
  if (provider === externalToolProvider) return 'externalTool'
  return null
}
