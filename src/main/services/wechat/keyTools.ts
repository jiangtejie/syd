import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { app } from 'electron'
import { getConfig } from '../../db/repos/config'
import { createLogger } from '../logging'
import { getKeyStatus, importKey, testKey } from '../keyStoreService'
import { locateWeChatDbs } from './dbLocator'
import { verifyWxDbKey } from './decrypt'
import { extractKeyCandidates, needsCmdShim, buildCmdLine, parsePathList } from './keyScanPure'
import { KEY_TOOL_PRESETS, matchPreset, presetById, type KeyToolPreset } from './keyToolPresets'

const log = createLogger('key-tools')

/**
 * 取 key 工具的「检测 + 一键使用」：把用户自备的工具接成开箱可用的一步。
 *
 * 设计要点：
 * - **只检测、不下载**：本仓不分发这些工具（授权与体积都不合适），只是帮用户找到机器上已有的；
 * - **多模板按顺序试**：工具 CLI 会随版本变，模板试错成本极低（一条命令），而**最终能否采用一律由页 1 HMAC 决定**；
 * - 命中后走与其它来源完全相同的落库路径（importKey + testKey），所以「试」永远不会污染密钥库。
 */

export interface DetectedKeyTool {
  id: string
  name: string
  /** 可执行文件绝对路径 */
  path: string
  /** 命中的预设（未命中为 null：仍可用通用 externalTool 接） */
  presetId: string | null
  note: string
  /** 已配置为当前外部工具 */
  active: boolean
}

/** 搜索目录：PATH + 常见安装位置 + 应用数据目录 + 用户配置的附加目录 */
export function keyToolSearchDirs(): string[] {
  const dirs: string[] = []
  for (const p of (process.env.PATH ?? '').split(';')) {
    if (p.trim()) dirs.push(p.trim())
  }
  const home = process.env.USERPROFILE || ''
  dirs.push(
    join(home, 'Downloads'),
    join(home, 'Desktop'),
    join(home, 'Documents'),
    join(home, 'AppData', 'Local', 'Programs'),
    join(process.env['ProgramFiles'] ?? 'C:\\Program Files'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'),
    join(app.getPath('userData'), 'tools')
  )
  dirs.push(...parsePathList(getConfig('wechat.keyTool.searchDirs') ?? ''))
  return [...new Set(dirs.filter(Boolean))]
}

/** 在搜索目录里找取 key 工具（只扫一层，避免把整盘翻一遍） */
export function detectKeyTools(): { tools: DetectedKeyTool[]; dirs: number } {
  const active = (getConfig('wechat.keyTool.command') ?? '').trim().toLowerCase()
  const found: DetectedKeyTool[] = []
  const seen = new Set<string>()
  const dirs = keyToolSearchDirs()
  for (const dir of dirs) {
    if (!dir || !existsSync(dir)) continue
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      const preset = matchPreset(name)
      if (!preset) continue
      const full = join(dir, name)
      try {
        if (!statSync(full).isFile()) continue
      } catch {
        continue
      }
      const lower = full.toLowerCase()
      if (seen.has(lower)) continue
      seen.add(lower)
      found.push({
        id: `${preset.id}:${lower}`,
        name: preset.name,
        path: full,
        presetId: preset.id,
        note: preset.note,
        active: active === lower
      })
    }
  }
  log.info(`取 key 工具检测：${found.length} 个（扫了 ${dirs.length} 个目录）`)
  return { tools: found, dirs: dirs.length }
}

/** 跑一条命令拿输出（.cmd/.bat 经 cmd.exe 包装，其余直接 execFile，均不走 shell） */
function runCommand(
  command: string,
  args: string[],
  timeoutMs = 30_000
): Promise<{ stdout: string; stderr: string; error?: string }> {
  const useShim = needsCmdShim(command)
  const target = useShim ? process.env.ComSpec || 'cmd.exe' : command
  const spawnArgs = useShim ? ['/d', '/s', '/c', buildCmdLine(command, args)] : args
  return new Promise((resolve) => {
    execFile(
      target,
      spawnArgs,
      {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        windowsVerbatimArguments: useShim
      },
      (err, so, se) => {
        resolve({
          stdout: String(so ?? ''),
          stderr: String(se ?? ''),
          error: err ? err.message : undefined
        })
      }
    )
  })
}

export interface KeyToolAttempt {
  command: string
  args: string[]
  /** ok=取到并通过页 1 校验；candidates=有候选但未过校验；empty=没候选；error=命令失败 */
  status: 'ok' | 'candidates' | 'empty' | 'error'
  detail: string
}

export interface KeyToolRunResult {
  ok: boolean
  key?: string
  attempts: KeyToolAttempt[]
  error?: string
  /** 命中后是否已落库并通过 testKey */
  imported?: boolean
  provider?: string
}

/**
 * 一键使用：按预设模板依次试（或直接试用户配置的命令），命中即落库。
 * 所有输出都当作不可信文本 → 只有通过页 1 HMAC 的候选才会被 importKey。
 */
export async function runKeyTool(opts: {
  wxid: string
  /** 指定已检测到的工具路径；不给则用配置里的外部工具命令 */
  command?: string
  /** 预设 id（决定模板）；不给则按文件名自动匹配 */
  presetId?: string
  timeoutMs?: number
}): Promise<KeyToolRunResult> {
  const wxid = (opts.wxid ?? '').trim()
  const attempts: KeyToolAttempt[] = []
  if (!wxid) return { ok: false, attempts, error: '缺少账号' }

  const command = (opts.command ?? getConfig('wechat.keyTool.command') ?? '').trim()
  if (!command) return { ok: false, attempts, error: '未指定工具，也未配置外部工具命令' }
  if (!existsSync(command)) return { ok: false, attempts, error: `命令不存在: ${command}` }

  const info = getKeyStatus(wxid)
  const paths = locateWeChatDbs(info.dbPath ?? '', wxid)
  const anyDb = paths.msgDbFiles[0] ?? paths.sessionDbFile ?? null
  if (!anyDb) {
    return {
      ok: false,
      attempts,
      error: '没定位到微信库文件，先把「微信数据根目录」填对（或用「一键接入」自动发现）'
    }
  }

  const preset: KeyToolPreset | null =
    (opts.presetId ? presetById(opts.presetId) : null) ?? matchPreset(command)
  const templates: string[][] = preset?.argTemplates.length ? preset.argTemplates : [[]]
  const timeout = opts.timeoutMs ?? 30_000
  const vars = { wxid, dbPath: info.dbPath ?? '', dbStorage: paths.dbStoragePath ?? '' }

  for (const template of templates) {
    const args = template.map((a) =>
      a.replace(/\{\{\s*wxid\s*\}\}/gi, vars.wxid).replace(/\{\{\s*dbPath\s*\}\}/gi, vars.dbPath)
    )
    const out = await runCommand(command, args, timeout)
    const candidates = extractKeyCandidates(`${out.stdout}\n${out.stderr}`)
    if (candidates.length === 0) {
      attempts.push({
        command,
        args,
        status: out.error ? 'error' : 'empty',
        detail: out.error ?? '输出里没有 64 位十六进制密钥'
      })
      continue
    }
    const hit = candidates.find((c) => verifyWxDbKey(anyDb, c).ok)
    if (!hit) {
      attempts.push({
        command,
        args,
        status: 'candidates',
        detail: `输出里有 ${candidates.length} 个候选，都没通过页 1 校验`
      })
      continue
    }
    attempts.push({ command, args, status: 'ok', detail: '密钥已通过页 1 校验' })
    const saved = importKey(wxid, hit, 'registry', info.dbPath ?? '')
    if (!saved.success) return { ok: false, attempts, error: saved.error ?? '落库失败' }
    testKey(wxid)
    log.info(`取 key 工具成功: ${preset?.name ?? command}（${args.join(' ') || '无参数'}）`)
    return {
      ok: true,
      key: hit,
      attempts,
      imported: true,
      provider: preset?.name ?? 'externalTool'
    }
  }

  const tips = attempts.map((a) => `${a.args.join(' ') || '(无参数)'}: ${a.detail}`).join('；')
  return {
    ok: false,
    attempts,
    error: `${preset?.name ?? command} 没取到可用密钥 —— ${tips}。若工具是新版本，可在设置里手填命令与参数。`
  }
}

/** 预设清单（界面展示用） */
export function listKeyToolPresets(): Array<{
  id: string
  name: string
  note: string
  templates: string[]
}> {
  return KEY_TOOL_PRESETS.map((p) => ({
    id: p.id,
    name: p.name,
    note: p.note,
    templates: p.argTemplates.map((t) => t.join(' ') || '(无参数)')
  }))
}
