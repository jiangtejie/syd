/**
 * 密钥获取的纯逻辑（零 IO，可离线自检）：候选提取 + 命令行拆解。
 *
 * 为什么要有「候选提取」这一步：自动获取密钥的**唯一安全边界**是「候选必须通过真实库的页 1 HMAC 校验」，
 * 所以上游（外部工具输出、本地文件、组件返回值）都可以被当成不可信文本 —— 这里只负责把可能的
 * 64 位十六进制密钥挑出来（去重、限量），校验与落库由调用方完成。
 */

/** 64 位十六进制（允许 0x 前缀、允许用空格/冒号/短横线分组） */
const SPACED_HEX_RE = /\b(?:0x)?([0-9a-fA-F]{2}(?:[\s:_-][0-9a-fA-F]{2}){31})\b/g
/** 连在一起的 64 位十六进制 */
const PLAIN_HEX_RE = /\b(?:0x)?([0-9a-fA-F]{64})\b/g

/** 单次最多返回多少个候选（每个候选要跑一次 PBKDF2 校验，必须限量） */
export const MAX_KEY_CANDIDATES = 20

/**
 * 从任意文本里提取密钥候选（去重 + 限量为 MAX_KEY_CANDIDATES）。
 * 支持：普通 64 hex、0x 前缀、以空格/冒号/短横线分组的 64 hex（工具常这么打印）。
 */
export function extractKeyCandidates(text: string, max = MAX_KEY_CANDIDATES): string[] {
  if (!text) return []
  const out: string[] = []
  const seen = new Set<string>()
  const push = (raw: string): void => {
    const hex = raw.replace(/[\s:_-]/g, '').toLowerCase()
    if (hex.length !== 64 || !/^[0-9a-f]{64}$/.test(hex)) return
    if (seen.has(hex)) return
    seen.add(hex)
    out.push(hex)
  }
  for (const m of text.matchAll(SPACED_HEX_RE)) push(m[1])
  for (const m of text.matchAll(PLAIN_HEX_RE)) push(m[1])
  return out.slice(0, max)
}

/**
 * 拆命令行参数（纯字符串处理，不走 shell）：
 * 支持双引号/单引号包住带空格的参数，支持 \\ 转义引号；未闭合的引号按「到结尾」处理。
 */
export function splitArgs(input: string): string[] {
  const args: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]
    if (ch === '\\' && i + 1 < input.length && (input[i + 1] === '"' || input[i + 1] === "'")) {
      cur += input[i + 1]
      i += 1
      started = true
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (/\s/.test(ch)) {
      if (started || cur) {
        args.push(cur)
        cur = ''
        started = false
      }
      continue
    }
    cur += ch
    started = true
  }
  if (started || cur) args.push(cur)
  return args
}

/** 把 {{wxid}} / {{dbPath}} / {{dbStorage}} 占位符替换成实际值（外部工具常用） */
export function expandPlaceholders(
  template: string,
  vars: { wxid: string; dbPath: string; dbStorage: string }
): string {
  return (template || '')
    .replace(/\{\{\s*wxid\s*\}\}/gi, vars.wxid)
    .replace(/\{\{\s*dbStorage\s*\}\}/gi, vars.dbStorage)
    .replace(/\{\{\s*dbPath\s*\}\}/gi, vars.dbPath)
}

/** 搜索路径列表（分号/换行/竖线分隔） */
export function parsePathList(input: string): string[] {
  return (input || '')
    .split(/[;\n|]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * 该命令是否是 Windows 的 .cmd/.bat 包装器 —— Node 的 execFile **无法直接执行**它们
 * （必须经 cmd.exe 解释），实测 node.cmd / npx.cmd 这类会直接 spawn EINVAL。
 * 用户配置外部工具时踩这个坑的概率很高（很多 CLI 装出来就是 .cmd），所以必须显式处理。
 */
export function needsCmdShim(command: string): boolean {
  const s = (command || '').trim().toLowerCase()
  return s.endsWith('.cmd') || s.endsWith('.bat')
}

/** Windows 命令行里的敏感字符（含空白）：命中才需要加引号 */
const SPECIAL_CHARS = ' \t"&|<>^()%!'
const BACKSLASH = '\\'
const DQUOTE = '"'

/**
 * 按 Windows 命令行规则转义单个参数（CommandLineToArgvW 的反斜杠/引号规则）。
 * 只在走 cmd.exe 包装器时使用；正常路径是 execFile 传数组，完全不经过 shell。
 */
export function quoteWinArg(arg: string): string {
  const s = arg ?? ''
  if (s === '') return '""'
  let needsQuote = false
  for (const ch of s) {
    if (SPECIAL_CHARS.indexOf(ch) >= 0) {
      needsQuote = true
      break
    }
  }
  if (!needsQuote) return s
  let out = DQUOTE
  let backslashes = 0
  for (const ch of s) {
    if (ch === BACKSLASH) {
      backslashes += 1
      continue
    }
    if (ch === DQUOTE) {
      out += BACKSLASH.repeat(backslashes * 2 + 1) + DQUOTE
      backslashes = 0
      continue
    }
    out += BACKSLASH.repeat(backslashes) + ch
    backslashes = 0
  }
  out += BACKSLASH.repeat(backslashes * 2) + DQUOTE
  return out
}

/** 拼一条完整的 cmd.exe 命令行（cmd shim 模式用） */
export function buildCmdLine(exe: string, args: string[]): string {
  return [exe, ...args].map(quoteWinArg).join(' ')
}
