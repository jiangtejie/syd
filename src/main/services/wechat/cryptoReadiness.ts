import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { getConfig, setConfig } from '../../db/repos/config'
import {
  getDecryptedKey,
  hasAnyKey,
  resolveKeyForFile,
  getKeyStatus,
  importKey,
  isValidKeyHex,
  testKey
} from '../keyStoreService'
import { locateWeChatDbs } from './dbLocator'
import { decryptWxDbFile, getPlainDbPath, verifyWxDbFileKey, verifyWxDbKey } from './decrypt'
import { getCachePath } from '../paths'
import { deriveImageKeys } from '../media/imageKeys'
import { mediaCachePolicy, mediaCacheStats } from '../media/mediaCache'
import { createLogger } from '../logging'
import { openSecret, sealSecret } from '../secrets'

const log = createLogger('crypto-center')

/**
 * 「解密一体化」的统一入口：把此前散在各处的解密相关能力（密钥 / 库解密 / 图片密钥 / 语音 / 转写 / 缓存）
 * 收成一个可体检、可一键接入、可预热的面。
 *
 * 为什么值得单独做一层：这些能力单看都能用，但运营一台「闲置机器上的数字员工」时，
 * 真正需要的是**一眼看清现在能不能用、不能用的那一步卡在哪、以及一键把它跑通** ——
 * 而不是让人在设置页里逐个试。这一层只做编排与状态汇总，具体实现仍各自复用。
 */

/** 体检里给用户看的密钥层级说明 */
const KEY_LAYER_LABEL: Record<string, string> = {
  passphrase: '账号口令（一把开全部库）',
  'db-keys': '每库派生密钥',
  none: '未获取'
}

export interface ReadinessStep {
  id: 'account' | 'key' | 'dbs' | 'images' | 'voice' | 'cache'
  label: string
  status: 'ok' | 'warn' | 'fail' | 'skip'
  detail: string
}

export interface DbProbe {
  name: string
  exists: boolean
  /** 明文副本是否新鲜（命中缓存） */
  cached: boolean
  pages: number | null
  error?: string
}

export interface AccountReadiness {
  ok: boolean
  wxid: string
  accountDir: string
  dbStoragePath: string | null
  key: { has: boolean; status: string | null; source: string | null; lastTestOk: boolean | null }
  dbs: DbProbe[]
  images: { xorKey: boolean; aesKey: boolean }
  voice: { mediaDbs: number; cachedWav: number }
  cache: {
    policy: { autoClean: boolean; keepDays: number; maxMB: number; maxFiles: number }
    files: number
    bytes: number
    archiveBytes: number
  }
  steps: ReadinessStep[]
}

/**
 * 发现本机微信账号目录（Documents\\xwechat_files\\wxid_xxx_xxxx）。
 *
 * 返回两种标识：
 * - `accountId`：**目录名**。本应用历史上就是用目录名当账号 id 存的密钥（例如 wxid_xxx_7e0b），
 *   必须优先用它去查 key_store，否则会「明明有密钥却说没有」；
 * - `wxid`：去掉结尾随机后缀得到的真正 wxid，用于对照消息库里的账号。
 */
export function discoverAccounts(
  extraRoots: string[] = []
): Array<{ accountId: string; wxid: string; dir: string }> {
  const roots = [
    join(process.env.USERPROFILE || '', 'Documents', 'xwechat_files'),
    join(process.env.USERPROFILE || '', 'Documents', 'WeChat Files'),
    ...extraRoots
  ]
  const out: Array<{ accountId: string; wxid: string; dir: string }> = []
  const seen = new Set<string>()
  for (const root of roots) {
    if (!root || !existsSync(root)) continue
    let entries: import('node:fs').Dirent[] = []
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const dir = join(root, e.name)
      if (!existsSync(join(dir, 'db_storage'))) continue
      // 目录名形如 wxid_xxx_7e0b：真正的 wxid 是不带后缀那段（去掉最后 3-6 位十六进制串）
      const accountId = e.name
      const wxid = accountId.replace(/_[0-9a-f]{3,6}$/i, '')
      if (seen.has(accountId)) continue
      seen.add(accountId)
      out.push({ accountId, wxid, dir })
    }
  }
  return out
}

/** 主要库探针：session / contact / message_0（有则列） */
function probeDbs(
  wxid: string,
  dbPath: string
): { storage: string | null; dbs: DbProbe[]; messageDb: string | null } {
  const paths = locateWeChatDbs(dbPath, wxid)
  const names = ['session.db', 'contact.db', 'message_0.db']
  const dbs: DbProbe[] = []
  let messageDb: string | null = null
  for (const name of names) {
    const file = paths.dbStoragePath ? findFile(paths.dbStoragePath, name) : null
    if (!file) {
      dbs.push({ name, exists: false, cached: false, pages: null })
      continue
    }
    if (name === 'message_0.db') messageDb = file
    const st = stampOf(file)
    dbs.push({
      name,
      exists: true,
      cached: false,
      pages: st ? Math.floor(st.size / 4096) : null
    })
  }
  return { storage: paths.dbStoragePath, dbs, messageDb }
}

function findFile(root: string, name: string, depth = 0): string | null {
  if (depth > 3) return null
  try {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      const full = join(root, e.name)
      if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return full
      if (e.isDirectory()) {
        const hit = findFile(full, name, depth + 1)
        if (hit) return hit
      }
    }
  } catch {
    /* ignore */
  }
  return null
}

function stampOf(file: string): { size: number; mtimeMs: number } | null {
  try {
    const st = statSync(file)
    return { size: st.size, mtimeMs: st.mtimeMs }
  } catch {
    return null
  }
}

/** 体检：把「现在能不能用、卡在哪一步」汇总成一份可展示的报告 */
export function accountReadiness(wxid: string): AccountReadiness {
  const id = (wxid || '').trim()
  const info = getKeyStatus(id)
  const accountDir = (info.dbPath ?? '').trim()
  const { storage, dbs } = probeDbs(id, accountDir)
  // 图片密钥已改为加封存储（enc1:），读侧必须开封 —— 否则会把密文当成密钥值去比对
  const xorKey = openSecret(getConfig(`img:${id}:xorKey`)).trim()
  const aesKey = openSecret(getConfig(`img:${id}:aesKey`)).trim()
  const cache = mediaCacheStats()
  const policy = mediaCachePolicy()

  const mediaDbs = accountDir ? countMediaDbs(accountDir) : 0
  const cachedWav = countCachedWav(id)

  const steps: ReadinessStep[] = []
  steps.push(
    accountDir && storage
      ? { id: 'account', label: '账号与数据目录', status: 'ok', detail: storage }
      : {
          id: 'account',
          label: '账号与数据目录',
          status: 'fail',
          detail: accountDir ? '未在数据目录下找到 db_storage' : '未配置微信数据根目录'
        }
  )
  steps.push(
    info.hasKey && info.status === 'valid'
      ? {
          id: 'key',
          label: '数据库密钥',
          status: 'ok',
          detail: `${KEY_LAYER_LABEL[info.layer]}，来源 ${info.source ?? '未知'}，页 1 校验通过`
        }
      : {
          id: 'key',
          label: '数据库密钥',
          status: info.hasKey ? 'warn' : 'fail',
          detail: info.hasKey
            ? `状态 ${info.status ?? '未知'}，建议点「测试解密」`
            : '未导入（粘贴 64 位十六进制账号口令，或点「导入密钥文件」整套导入）'
        }
  )
  const missing = dbs.filter((d) => !d.exists).map((d) => d.name)
  steps.push(
    missing.length === 0
      ? {
          id: 'dbs',
          label: '主要库可定位',
          status: 'ok',
          detail: dbs.map((d) => d.name).join(' / ')
        }
      : {
          id: 'dbs',
          label: '主要库可定位',
          status: 'warn',
          detail: `缺少 ${missing.join(', ')}（不影响已存在的库，但功能会受限）`
        }
  )
  steps.push(
    xorKey || aesKey
      ? {
          id: 'images',
          label: '图片解密密钥',
          status: 'ok',
          detail: [xorKey && 'XOR', aesKey && 'AES'].filter(Boolean).join(' + ')
        }
      : {
          id: 'images',
          label: '图片解密密钥',
          status: 'warn',
          detail: '未配置（可点「自动推导图片密钥」）'
        }
  )
  steps.push(
    mediaDbs > 0
      ? {
          id: 'voice',
          label: '语音',
          status: 'ok',
          detail: `media_*.db ${mediaDbs} 个，已缓存 WAV ${cachedWav} 条`
        }
      : {
          id: 'voice',
          label: '语音',
          status: 'warn',
          detail: '未找到 media_*.db（可能还没收到过语音）'
        }
  )
  steps.push({
    id: 'cache',
    label: '解密/媒体缓存',
    status: 'ok',
    detail: `明文库与媒体缓存共 ${cache.files} 个文件/${mb(cache.bytes)}；归档 ${mb(cache.archiveBytes)}（不清理）；保留 ${policy.keepDays} 天`
  })

  const ok = steps.every((s) => s.status !== 'fail')
  return {
    ok,
    wxid: id,
    accountDir,
    dbStoragePath: storage,
    key: {
      has: info.hasKey,
      status: info.status,
      source: info.source,
      lastTestOk: info.lastTestOk
    },
    dbs,
    images: { xorKey: !!xorKey, aesKey: !!aesKey },
    voice: { mediaDbs, cachedWav },
    cache: { policy, files: cache.files, bytes: cache.bytes, archiveBytes: cache.archiveBytes },
    steps
  }
}

function mb(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${Math.round(bytes / 1024 / 1024)}MB`
    : `${Math.max(1, Math.round(bytes / 1024))}KB`
}

function countMediaDbs(accountDir: string): number {
  try {
    const dir = join(accountDir, 'db_storage', 'message')
    return readdirSync(dir).filter((n) => /^media_\d+\.db$/i.test(n)).length
  } catch {
    return 0
  }
}

function countCachedWav(wxid: string): number {
  try {
    const dir = join(getCachePath(), 'media', wxid, 'voices')
    return readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.wav')).length
  } catch {
    return 0
  }
}

export interface WarmupItem {
  name: string
  ok: boolean
  ms: number
  pages?: number
  walMerged?: boolean
  cached?: boolean
  error?: string
}

export interface WarmupReport {
  ok: boolean
  items: WarmupItem[]
}

/**
 * 预热解密：把主要库先解一遍（落到明文副本缓存）。
 * 目的：让「首次打开会话/首次分析」不再承担解密开销，运营侧能提前知道要多久。
 */
export function warmupAccount(wxid: string, limit = 3): WarmupReport {
  const id = (wxid || '').trim()
  const info = getKeyStatus(id)
  const items: WarmupItem[] = []
  // 只有密钥文件（每库派生密钥）时没有账号口令，但每个库都有自己的钥匙，照样能预热
  if (!hasAnyKey(id)) {
    return { ok: false, items: [{ name: '(密钥)', ok: false, ms: 0, error: '未导入密钥' }] }
  }
  const paths = locateWeChatDbs(info.dbPath ?? '', id)
  const files: string[] = []
  if (paths.sessionDbFile) files.push(paths.sessionDbFile)
  for (const f of paths.msgDbFiles.slice(0, Math.max(1, limit - files.length))) files.push(f)
  for (const file of files.slice(0, limit)) {
    const started = Date.now()
    const key = resolveKeyForFile(id, file)
    if (!key) {
      items.push({
        name: basename(file),
        ok: false,
        ms: 0,
        error: '该库没有对应的密钥（密钥环未覆盖）'
      })
      continue
    }
    const out = getPlainDbPath(file, key)
    const r = decryptWxDbFile(file, key, out)
    items.push({
      name: basename(file),
      ok: r.ok,
      ms: Date.now() - started,
      pages: r.pages,
      walMerged: r.wal?.merged ?? false,
      error: r.error
    })
  }
  const ok = items.length > 0 && items.every((i) => i.ok)
  log.info(`预热解密 ${id}: ${items.filter((i) => i.ok).length}/${items.length} 成功`)
  return { ok, items }
}

export interface OnboardReport {
  ok: boolean
  wxid: string
  accountDir: string
  steps: ReadinessStep[]
}

/**
 * 一键接入：定位账号 → 取密钥（粘贴优先，其次三来源）→ 推导图片密钥 → 预热 → 回体检。
 * 只做「能让解密链路跑起来」的事；连接与监控由 IPC 层在成功后再拉起。
 */
export async function onboardAccount(opts: {
  wxid?: string
  dbPath?: string
  /** 用户粘贴的 64 位十六进制（有就用它，且必须过页 1 校验） */
  keyHex?: string
}): Promise<OnboardReport> {
  const steps: ReadinessStep[] = []
  let wxid = (opts.wxid ?? '').trim()
  let accountDir = (opts.dbPath ?? '').trim()

  // 1) 账号 + 目录：显式参数 → 已存密钥档案里的目录 → 本机发现（按 账号id/派生wxid/目录名 三种都能对上）
  if (!accountDir && wxid) accountDir = (getKeyStatus(wxid).dbPath ?? '').trim()
  if (!wxid || !accountDir) {
    const found = discoverAccounts()
    const hit =
      found.find(
        (f) =>
          (wxid && (f.accountId === wxid || f.wxid === wxid)) ||
          (accountDir && f.dir.toLowerCase() === accountDir.toLowerCase())
      ) ?? (wxid || accountDir ? undefined : found[0])
    if (hit) {
      // 目录名才是本应用既有的账号 id：查密钥必须用它，否则会「有密钥却查不到」
      if (!wxid || (!getKeyStatus(wxid).hasKey && getKeyStatus(hit.accountId).hasKey)) {
        wxid = hit.accountId
      }
      accountDir = accountDir || hit.dir
    }
  }
  if (!wxid || !accountDir) {
    steps.push({
      id: 'account',
      label: '账号与数据目录',
      status: 'fail',
      detail:
        '没找到微信账号目录（Documents\\xwechat_files 下没有 db_storage），请手动填写数据根路径'
    })
    return { ok: false, wxid, accountDir, steps }
  }
  const paths = locateWeChatDbs(accountDir, wxid)
  steps.push({
    id: 'account',
    label: '账号与数据目录',
    status: paths.dbStoragePath ? 'ok' : 'fail',
    detail: paths.dbStoragePath ?? `${accountDir} 下没有 db_storage`
  })
  if (!paths.dbStoragePath) return { ok: false, wxid, accountDir, steps }

  // 2) 密钥：粘贴优先 → 校验 → 落库；否则走三来源
  const anyDb = paths.msgDbFiles[0] ?? paths.sessionDbFile ?? null
  let keyOk = false
  let keyDetail = ''
  const pasted = (opts.keyHex ?? '').trim()
  if (pasted) {
    if (!isValidKeyHex(pasted)) {
      keyDetail = '粘贴的密钥不是 64 位十六进制'
    } else {
      const check = anyDb
        ? verifyWxDbKey(anyDb, pasted)
        : { ok: false, error: '没有可校验的库文件' }
      if (check.ok) {
        const saved = importKey(wxid, pasted, 'manual', accountDir)
        if (saved.success) {
          testKey(wxid)
          keyOk = true
          keyDetail = '已用粘贴的密钥（页 1 校验通过）'
        } else {
          keyDetail = saved.error ?? '保存失败'
        }
      } else {
        keyDetail = check.error ?? '密钥未通过校验'
      }
    }
  } else {
    // 自动取 key 已按用户决定下线：这里只在「已经导入过密钥」时放行，否则要求粘贴
    const existing = getDecryptedKey(wxid)
    if (existing) {
      const check = anyDb
        ? verifyWxDbKey(anyDb, existing)
        : { ok: false, error: '没有可校验的库文件' }
      if (check.ok) {
        keyOk = true
        keyDetail = '使用已导入的密钥（页 1 校验通过）'
      } else {
        keyDetail = `已导入的密钥未通过校验：${check.error ?? '未知原因'}；请在设置里重新导入或粘贴新密钥`
      }
    } else if (hasAnyKey(wxid)) {
      // 只导入了密钥文件（每库派生密钥）：逐库各取各的钥匙校验，通过即可放行
      const ringSize = getKeyStatus(wxid).keyRingSize
      const ringKey = anyDb ? resolveKeyForFile(wxid, anyDb) : null
      const check = ringKey && anyDb ? verifyWxDbFileKey(anyDb, ringKey) : null
      if (check?.ok) {
        keyOk = true
        keyDetail = `使用已导入的每库派生密钥（${ringSize} 条，页 1 校验通过）`
      } else {
        keyDetail =
          `已导入的 ${ringSize} 条派生密钥里没有 ${anyDb ? basename(anyDb) : '任何库'} 对应的那一把；` +
          '请在设置里重新「导入密钥文件」，或粘贴账号口令'
      }
    } else {
      keyDetail =
        '未导入密钥：请粘贴 64 位十六进制账号口令，或在设置里「导入密钥文件」（自动获取已停用）'
    }
  }
  steps.push({
    id: 'key',
    label: '数据库密钥',
    status: keyOk ? 'ok' : 'fail',
    detail: keyDetail
  })
  if (!keyOk) return { ok: false, wxid, accountDir, steps }

  // 3) 图片密钥（能推就推，推不出来不影响主链路）
  try {
    const derived = deriveImageKeys(accountDir)
    if (derived.ok && typeof derived.xorKey === 'number') {
      // 加封后再落库：密钥（哪怕只是图片 XOR 密钥）不该以明文长期躺在 app_config 里
      setConfig(`img:${wxid}:xorKey`, sealSecret(`0x${derived.xorKey.toString(16).toUpperCase()}`))
      if (derived.aesVerified && derived.aesKey) {
        setConfig(`img:${wxid}:aesKey`, sealSecret(derived.aesKey))
      }
      steps.push({
        id: 'images',
        label: '图片解密密钥',
        status: 'ok',
        detail: `已推导 XOR 0x${derived.xorKey.toString(16).toUpperCase()}${derived.aesVerified ? ' + AES 校验通过' : ''}`
      })
    } else {
      steps.push({
        id: 'images',
        label: '图片解密密钥',
        status: 'warn',
        detail: derived.error ?? '推导失败，可稍后手填'
      })
    }
  } catch (e) {
    steps.push({
      id: 'images',
      label: '图片解密密钥',
      status: 'warn',
      detail: e instanceof Error ? e.message : '推导失败'
    })
  }

  // 4) 预热解密
  const warm = warmupAccount(wxid)
  steps.push({
    id: 'dbs',
    label: '预热解密',
    status: warm.ok ? 'ok' : 'warn',
    detail:
      warm.items
        .map(
          (i) =>
            `${i.name} ${i.ok ? `${i.ms}ms${i.pages ? `/${i.pages} 页` : ''}` : `失败(${i.error ?? ''})`}`
        )
        .join('；') || '没有可预热的库'
  })

  // 5) 体检收尾（把语音/转写/缓存的状态一并带出来）
  const ready = accountReadiness(wxid)
  const extra = ready.steps.filter((s) => s.id === 'voice' || s.id === 'cache')
  steps.push(...extra)
  return { ok: steps.every((s) => s.status !== 'fail'), wxid, accountDir, steps }
}
