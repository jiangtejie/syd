import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { verifyWxDbKey } from './decrypt'
import { locateWeChatDbs } from './dbLocator'
import { createLogger } from '../logging'

const keyLog = createLogger('wx-key-scan')

/**
 * 微信库密钥的「自动获取」入口（可选组件，**本仓不随包分发**）。
 *
 * 背景：微信 4.x 的库密钥只存在于微信进程内存里，社区实现（CipherTalk 的 wxKeyService 一类）
 * 靠 koffi + 自研 DLL 读进程内存 + Ed25519 握手拿 key。这类组件有独立授权，
 * 我们不分发、不内置，只留一个**接口 + 明确降级**：
 *
 *   1. 用户把**已授权**的组件放到 `<userData>/components/key-scan/`，入口文件 `index.cjs`；
 *   2. 该文件导出 `scan(ctx) => Promise<string | null>`，ctx 里给足 `wxid / dbPath / verify`；
 *   3. 组件只管「找出候选 key」，**校验交给我们的 `verify`**（页 1 HMAC），
 *      拿到 key 后仍走 `keyStoreService.importKey` 落 safeStorage。
 *
 * 没有组件时不能装作能用：直接返回「未安装」+ 手填路径，让用户知道下一步做什么。
 */

/** 组件目录：<userData>/components/key-scan */
export function keyScanComponentDir(): string {
  return join(app.getPath('userData'), 'components', 'key-scan')
}

export interface KeyScanContext {
  wxid: string
  /** 微信 db_storage 路径（组件可据此找库） */
  dbStoragePath: string | null
  /** 校验候选 key：页 1 HMAC 通过才认（组件不需要懂我们的加密细节） */
  verify: (candidateHex: string) => boolean
}

export interface KeyScanComponent {
  scan: (ctx: KeyScanContext) => Promise<string | null> | string | null
}

export interface KeyScanResult {
  ok: boolean
  /** 通过校验的 64 位十六进制密钥（调用方负责落库） */
  key?: string
  /** 组件未安装：这是**预期**状态，不是错误 */
  installed?: boolean
  error?: string
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

const NOT_INSTALLED =
  '未安装密钥扫描组件（可选）：本应用不随包分发这类组件，请手动导入 64 位十六进制密钥；' +
  '如需自动获取，把已授权的组件放到 ' +
  '`<用户数据目录>\\components\\key-scan\\index.cjs`（导出 scan(ctx)）后重试。'

/**
 * 尝试自动获取密钥。任何异常都收敛成「失败 + 原因」，不抛给 IPC 层。
 * 成功 = 组件给出候选 key 且**页 1 HMAC 校验通过**（避免把错 key 存进安全存储）。
 */
export async function scanWeChatKey(opts: {
  wxid: string
  dbPath?: string
}): Promise<KeyScanResult> {
  const wxid = (opts.wxid ?? '').trim()
  if (!wxid) return { ok: false, error: '缺少账号' }
  if (!isKeyScanComponentInstalled()) {
    return { ok: false, installed: false, error: NOT_INSTALLED }
  }

  const paths = locateWeChatDbs(opts.dbPath ?? '', wxid)
  const anyDb = paths.msgDbFiles[0] ?? paths.sessionDbFile ?? null
  if (!anyDb) {
    return { ok: false, installed: true, error: '没定位到微信库文件，先填对「微信数据根目录」再试' }
  }

  const verify = (candidateHex: string): boolean => verifyWxDbKey(anyDb, candidateHex).ok

  try {
    const entry = join(keyScanComponentDir(), 'index.cjs')
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- 组件是运行时可选加载的
    const mod = require(entry) as Partial<KeyScanComponent> & { default?: KeyScanComponent }
    const scan = mod.scan ?? mod.default?.scan
    if (typeof scan !== 'function') {
      return { ok: false, installed: true, error: '组件入口没有导出 scan(ctx) 函数' }
    }
    const candidate = await scan({ wxid, dbStoragePath: paths.dbStoragePath, verify })
    const hex = typeof candidate === 'string' ? candidate.trim() : ''
    if (!hex) {
      return { ok: false, installed: true, error: '组件没能取到候选密钥（微信可能没在运行）' }
    }
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      return { ok: false, installed: true, error: '组件返回的密钥不是 64 位十六进制' }
    }
    if (!verify(hex)) {
      return { ok: false, installed: true, error: '组件给出的密钥没通过页 1 校验，已丢弃' }
    }
    return { ok: true, key: hex.toLowerCase(), installed: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    keyLog.warn(`key-scan 组件执行失败: ${msg}`)
    return { ok: false, installed: true, error: `组件执行失败: ${msg}` }
  }
}
