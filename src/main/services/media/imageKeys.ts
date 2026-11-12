import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { createDecipheriv } from 'node:crypto'
import { detectImageExtension } from './datDecrypt'

/**
 * 图片密钥的**本地推导**（不需要内存扫描、不需要任何原生依赖）。
 *
 * 事实来源：微信会在账号目录下留下 `<md5>_t.dat` 缩略图模板，它们尾部两字节与 XOR 密钥存在固定关系；
 * 另外带 V2 头的模板里有一段 16 字节「明文探测段」，用它反解可以**判定 AES 密钥对不对**。
 *
 * 于是设置页可以从「让人手填两个密钥、填错只在解密时静默失败」变成：
 *   一键推导 XOR → 校验用户填的/推导出的 AES → 通过才保存。
 *
 * 参考实现：jiangtejie/wx-decode（MIT）src/imageKeys.ts 的推导与校验思路，按我们自己的调用方式重写。
 */

/** 扫描上限：账号目录很深，避免一次 walk 卡住（模板文件很小，64 个足够投票） */
const MAX_TEMPLATES = 64
const MAX_DEPTH = 8
/** V2 头部签名：07 08 56 32 08 07 */
const V2_SIGNATURE = [0x07, 0x08, 0x56, 0x32, 0x08, 0x07]

export interface DatTemplateScan {
  /** 参与投票的模板文件数 */
  templateCount: number
  /** 推导出的 XOR 密钥（0-255）；null = 推导失败 */
  xorKey: number | null
  /** 是否通过 y === xorKey ^ 0xd9 自校验（通过才算可信） */
  xorVerified: boolean
  /** 投票一致度（支持该 XOR 值的模板数） */
  xorVotes: number
  /** V2 模板里的 16 字节探测段（用于校验 AES 密钥） */
  aesProbe: { ciphertext: Buffer; file: string } | null
  /** 找到的模板示例（报错信息里给用户一点线索） */
  sample: string | null
}

/** 收集 `*_t.dat` 模板（BFS，浅层优先，找满即停） */
function collectTemplates(accountDir: string): string[] {
  const out: string[] = []
  let frontier: Array<{ dir: string; depth: number }> = [{ dir: accountDir, depth: 0 }]
  while (frontier.length > 0 && out.length < MAX_TEMPLATES) {
    const next: Array<{ dir: string; depth: number }> = []
    for (const node of frontier) {
      if (out.length >= MAX_TEMPLATES) break
      let entries: Dirent[]
      try {
        entries = readdirSync(node.dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        const full = join(node.dir, e.name)
        if (e.isDirectory()) {
          if (node.depth + 1 <= MAX_DEPTH) next.push({ dir: full, depth: node.depth + 1 })
        } else if (e.isFile() && e.name.toLowerCase().endsWith('_t.dat')) {
          out.push(full)
          if (out.length >= MAX_TEMPLATES) break
        }
      }
    }
    frontier = next
  }
  return out
}

/** 从模板尾部两字节推导 XOR 密钥（投票 + 自校验） */
function deriveXor(templates: string[]): { xorKey: number | null; votes: number } {
  const votes = new Map<string, number>()
  for (const t of templates) {
    try {
      const buf = readFileSync(t)
      if (buf.length < 4) continue
      const key = `${buf[buf.length - 2]}_${buf[buf.length - 1]}`
      votes.set(key, (votes.get(key) ?? 0) + 1)
    } catch {
      /* 读不了就跳过 */
    }
  }
  let best = ''
  let bestCount = 0
  for (const [k, n] of votes) {
    if (n > bestCount) {
      best = k
      bestCount = n
    }
  }
  if (!best) return { xorKey: null, votes: 0 }
  const [x, y] = best.split('_').map((v) => Number(v))
  const xorKey = x ^ 0xff
  if (xorKey !== (y ^ 0xd9)) return { xorKey: null, votes: bestCount }
  return { xorKey, votes: bestCount }
}

/** 找带 V2 头且够长的模板：取其 0x0f..0x1f 作为 AES 探测段 */
function findAesProbe(templates: string[]): { ciphertext: Buffer; file: string } | null {
  for (const t of templates) {
    try {
      const buf = readFileSync(t)
      if (buf.length < 0x1f) continue
      if (!V2_SIGNATURE.every((b, i) => buf[i] === b)) continue
      return { ciphertext: Buffer.from(buf.subarray(0x0f, 0x1f)), file: t }
    } catch {
      /* 跳过 */
    }
  }
  return null
}

/** 扫账号目录：返回 XOR/AES 推导素材 */
export function scanDatTemplates(accountDir: string): DatTemplateScan {
  if (!accountDir || !statExists(accountDir)) {
    return {
      templateCount: 0,
      xorKey: null,
      xorVerified: false,
      xorVotes: 0,
      aesProbe: null,
      sample: null
    }
  }
  const templates = collectTemplates(accountDir)
  const { xorKey, votes } = deriveXor(templates)
  return {
    templateCount: templates.length,
    xorKey,
    xorVerified: xorKey !== null,
    xorVotes: votes,
    aesProbe: findAesProbe(templates),
    sample: templates[0] ?? null
  }
}

function statExists(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * AES 密钥是否正确：用模板的探测段反解，能解出图片头才算对。
 * 这段密文是 16 字节、ECB 无填充，因此「解出来像不像图片」是强判据（误判概率极低）。
 */
export function aesKeyLooksRight(probeCiphertext: Buffer, aesKey: Buffer): boolean {
  if (probeCiphertext.length < 16 || aesKey.length < 16) return false
  try {
    const decipher = createDecipheriv('aes-128-ecb', aesKey.subarray(0, 16), null)
    decipher.setAutoPadding(false)
    const plain = Buffer.concat([decipher.update(probeCiphertext), decipher.final()])
    return detectImageExtension(plain) !== null || isWxgf(plain)
  } catch {
    return false
  }
}

function isWxgf(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x77 && buf[1] === 0x78 && buf[2] === 0x67 && buf[3] === 0x66
}

export interface DeriveImageKeysResult {
  ok: boolean
  error?: string
  xorKey?: number
  /** 推导出的 AES 候选：md5(图片码 + wxid)[:16] 与模板探测段的组合校验（无候选时为空） */
  aesKey?: string
  templateCount?: number
  xorVotes?: number
  /** XOR 是否通过自校验 */
  xorVerified?: boolean
  /** AES 是否用模板探测段验过 */
  aesVerified?: boolean
  aesProbeFile?: string
}

/**
 * 一键推导：XOR 必得（有模板即可）；AES 只做**校验**（候选值需要图片码或内存扫描，见注释）。
 * 传入 knownAesKey 时用模板探测段验证它；验证失败会明确告知「这个密钥不对」。
 */
export function deriveImageKeys(accountDir: string, knownAesKey?: string): DeriveImageKeysResult {
  const scan = scanDatTemplates(accountDir)
  if (scan.templateCount === 0) {
    return {
      ok: false,
      error: '账号目录下没找到 *_t.dat 模板（微信未产生过图片，或路径不对）',
      templateCount: 0
    }
  }
  if (scan.xorKey === null) {
    return {
      ok: false,
      error: '模板尾部字节不一致，无法推导 XOR 密钥（可能只扫到了半份缓存）',
      templateCount: scan.templateCount
    }
  }
  const out: DeriveImageKeysResult = {
    ok: true,
    xorKey: scan.xorKey,
    templateCount: scan.templateCount,
    xorVotes: scan.xorVotes,
    xorVerified: scan.xorVerified
  }
  const provided = (knownAesKey ?? '').trim()
  if (provided && scan.aesProbe) {
    const key = Buffer.from(provided, 'ascii').subarray(0, 16)
    out.aesVerified = aesKeyLooksRight(scan.aesProbe.ciphertext, key)
    out.aesProbeFile = scan.aesProbe.file
    if (!out.aesVerified) {
      out.error = 'AES 密钥与模板探测段不匹配（这个密钥不正确，或它属于另一个账号）'
    }
  } else if (provided) {
    out.aesVerified = false
    out.error = '没有可用于校验 AES 的 V2 模板，无法验证该密钥'
  }
  return out
}
