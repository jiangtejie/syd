import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createDecipheriv } from 'node:crypto'

/**
 * 微信 .dat 图片解密纯函数核心（自研实现）。
 *
 * 格式事实（参考 CipherTalk datDecryptCore / chat-sync decrypt-media 的公开格式要点，
 * 算法自研实现，仅依赖 node:fs + node:crypto）：
 * - V1/V2（带 15 字节头）：aesSize 头 [6..10)、xorSize 头 [10..14)
 *   AES-128-ECB 解密头部 + XOR 单字节解密尾部（PKCS7 填充校验）
 * - V3（无头）：整文件 XOR 单字节；若本身已是明文图片则直接透传
 * - 解密结果可能是 wxgf（HEVC 容器），内嵌 JPEG/PNG 时可直接截取
 *
 * XOR key / AES key 由外部注入（设置页 img:{wxid}:xorKey/aesKey）。
 */

/** V1 固定 AES key（ascii 16 字符，老版本图片段固定使用） */
const V1_FIXED_AES_TEXT = 'cfcd208495d565ef'

/** ascii 文本取前 16 字节作为 AES key（与 CipherTalk asciiKey16 语义一致） */
export function asciiKey16(keyText: string): Buffer {
  return Buffer.from(keyText, 'ascii').subarray(0, 16)
}

/** XOR key 解析：0x 前缀 hex / 纯 hex（含 a-f）/ 十进制，均须为 1 字节范围；null 表示未配置 */
export function parseXorKey(raw: string | undefined | null): number | null {
  const s = (raw ?? '').trim()
  if (!s) return null
  let n: number
  if (/^0[xX]/.test(s)) {
    n = parseInt(s.slice(2), 16)
  } else if (/^[0-9a-fA-F]{1,2}$/.test(s) && /[a-fA-F]/.test(s)) {
    n = parseInt(s, 16)
  } else {
    n = parseInt(s, 10)
  }
  if (!Number.isFinite(n) || n < 0 || n > 255) return null
  return n
}

/** 16 字节 ascii 文本（AES key 语义），兼容 32 位 hex 的输入转 16 字节 */
export function parseAesKey(raw: string | undefined | null): Buffer | null {
  const s = (raw ?? '').trim()
  if (!s) return null
  if (/^[0-9a-fA-F]{32}$/.test(s)) return Buffer.from(s, 'hex')
  return asciiKey16(s)
}

function bytesToInt32(bytes: Buffer): number {
  return bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)
}

function strictRemovePadding(data: Buffer): Buffer {
  if (!data.length) throw new Error('解密结果为空')
  const pad = data[data.length - 1]
  if (pad === 0 || pad > 16 || pad > data.length) throw new Error('PKCS7 填充长度非法')
  for (let i = data.length - pad; i < data.length; i++) {
    if (data[i] !== pad) throw new Error('PKCS7 填充内容非法')
  }
  return data.subarray(0, data.length - pad)
}

/** 纯 XOR（V3 / 无头 dat），已是明文图片则透传 */
export function decryptXorOnly(data: Buffer, xorKey: number | null): Buffer {
  if (!xorKey) return data
  if (detectImageExtension(data)) return stripTrailingNulBytes(data)
  const out = Buffer.alloc(data.length)
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ xorKey
  return out
}

/** 裁掉尾部连续 0x00（明文 .dat 常带尾部填充） */
export function stripTrailingNulBytes(data: Buffer): Buffer {
  let end = data.length
  while (end > 0 && data[end - 1] === 0) end--
  return data.subarray(0, end)
}

/** V1/V2 带 15 字节头的 dat：AES-128-ECB 段 + 明文段 + XOR 段 */
export function decryptAesXor(data: Buffer, xorKey: number | null, aesKey: Buffer | null): Buffer {
  if (data.length < 0x0f) throw new Error('文件太小，无法解析')
  const payload = data.subarray(0x0f)
  const aesSize = bytesToInt32(data.subarray(6, 10))
  const xorSize = bytesToInt32(data.subarray(10, 14))
  if (aesSize < 0 || xorSize < 0) throw new Error('头部长度字段非法')

  const remainder = ((aesSize % 16) + 16) % 16
  const alignedAesSize = aesSize + (16 - remainder)
  if (alignedAesSize > payload.length) throw new Error('AES 数据长度超过文件实际长度')

  const aesData = payload.subarray(0, alignedAesSize)
  let unpadded: Buffer = Buffer.alloc(0)
  if (aesData.length > 0) {
    if (!aesKey) throw new Error('图片为 V2 加密，请先配置图片 AES 密钥')
    const decipher = createDecipheriv('aes-128-ecb', aesKey, null)
    decipher.setAutoPadding(false)
    const decrypted = Buffer.concat([decipher.update(aesData), decipher.final()])
    unpadded = strictRemovePadding(decrypted)
  }

  const remaining = payload.subarray(alignedAesSize)
  if (xorSize > remaining.length) throw new Error('XOR 数据长度超过文件实际长度')
  const rawLength = remaining.length - xorSize
  const rawData = remaining.subarray(0, rawLength)
  let xoredData: Buffer
  if (xorSize > 0 && xorKey) {
    xoredData = Buffer.alloc(xorSize)
    for (let i = 0; i < xorSize; i++) {
      xoredData[i] = remaining[rawLength + i] ^ xorKey
    }
  } else {
    xoredData = remaining.subarray(rawLength)
  }
  return Buffer.concat([unpadded, rawData, xoredData])
}

/** 探测 dat 版本：V1（07 08 56 31）、V2（07 08 56 32）、V3（无头/其他） */
export function detectDatVersion(data: Buffer): 1 | 2 | 3 {
  const sig = data.subarray(0, 6)
  if (
    data.length >= 6 &&
    sig[0] === 0x07 &&
    sig[1] === 0x08 &&
    sig[2] === 0x56 &&
    sig[3] === 0x31 &&
    sig[4] === 0x08 &&
    sig[5] === 0x07
  ) {
    return 1
  }
  if (
    data.length >= 6 &&
    sig[0] === 0x07 &&
    sig[1] === 0x08 &&
    sig[2] === 0x56 &&
    sig[3] === 0x32 &&
    sig[4] === 0x08 &&
    sig[5] === 0x07
  ) {
    return 2
  }
  return 3
}

export interface DecryptDatResult {
  data: Buffer
  version: 1 | 2 | 3
  /** 解密后是否为 wxgf（HEVC 容器） */
  isWxgf: boolean
}

/** 解密 .dat 数据（自动版本分流） */
export function decryptDatBytes(
  data: Buffer,
  xorKey: number | null,
  aesKey: Buffer | null
): DecryptDatResult {
  const version = detectDatVersion(data)
  if (version === 3) {
    const out = decryptXorOnly(data, xorKey)
    return { data: out, version, isWxgf: isWxgf(out) }
  }
  if (version === 1) {
    const out = decryptAesXor(data, xorKey, asciiKey16(V1_FIXED_AES_TEXT))
    return { data: out, version, isWxgf: isWxgf(out) }
  }
  const out = decryptAesXor(data, xorKey, aesKey)
  return { data: out, version, isWxgf: isWxgf(out) }
}

export function isWxgf(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x77 && buf[1] === 0x78 && buf[2] === 0x67 && buf[3] === 0x66
}

/** 探测图片扩展名（含 wxgf 内嵌 JPEG/PNG 偏移扫描） */
export function detectImageExtension(buf: Buffer): string | null {
  if (buf.length < 12) return null
  const checkAt = (o: number): string | null => {
    if (buf.length < o + 12) return null
    const b = buf
    if (b[o] === 0xff && b[o + 1] === 0xd8 && b[o + 2] === 0xff) return '.jpg'
    if (b[o] === 0x89 && b[o + 1] === 0x50 && b[o + 2] === 0x4e && b[o + 3] === 0x47) return '.png'
    if (b[o] === 0x47 && b[o + 1] === 0x49 && b[o + 2] === 0x46) return '.gif'
    if (
      b[o] === 0x52 &&
      b[o + 1] === 0x49 &&
      b[o + 2] === 0x46 &&
      b[o + 3] === 0x46 &&
      b[o + 8] === 0x57 &&
      b[o + 9] === 0x45 &&
      b[o + 10] === 0x42 &&
      b[o + 11] === 0x50
    ) {
      return '.webp'
    }
    return null
  }
  const direct = checkAt(0)
  if (direct) return direct

  // wxgf：尝试常见偏移 + 前 512 字节内暴力搜 JPEG 签名
  if (isWxgf(buf)) {
    for (const off of [0x10, 0x12, 0x14, 0x18, 0x20, 0xd0, 0x100]) {
      const ext = checkAt(off)
      if (ext) return ext
    }
    for (let i = 4; i < Math.min(buf.length - 3, 512); i++) {
      if (buf[i] === 0xff && buf[i + 1] === 0xd8 && buf[i + 2] === 0xff) return '.jpg'
    }
  }
  return null
}

/** 从 wxgf 中提取内嵌 JPEG/PNG（找不到返回 null）。签名只在前 4KB 内探测，防 HEVC 载荷深处误中魔数 */
export function extractEmbeddedImage(buf: Buffer): Buffer | null {
  if (!isWxgf(buf)) return null
  const scanEnd = Math.min(buf.length - 8, 4096)
  for (let i = 4; i < scanEnd; i++) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd8 && buf[i + 2] === 0xff) {
      const jpg = buf.subarray(i)
      const end = findJpegEnd(jpg)
      return end > 0 ? jpg.subarray(0, end) : jpg
    }
    if (buf[i] === 0x89 && buf[i + 1] === 0x50 && buf[i + 2] === 0x4e && buf[i + 3] === 0x47) {
      return buf.subarray(i)
    }
  }
  return null
}

/** 找 JPEG EOI 标记（ff d9），找不到返回 -1 */
function findJpegEnd(jpg: Buffer): number {
  for (let i = jpg.length - 2; i > 0; i--) {
    if (jpg[i] === 0xff && jpg[i + 1] === 0xd9) return i + 2
  }
  return -1
}

/** 读文件并解密（便捷入口，供 service 层使用） */
export function decryptDatFile(
  filePath: string,
  xorKey: number | null,
  aesKey: Buffer | null
): DecryptDatResult {
  const data = readFileSync(filePath)
  return decryptDatBytes(data, xorKey, aesKey)
}

// ─────────────────────────────────────────────────────────────
// wxgf（微信 HEVC 图片容器）→ 可视图片
// 参考 chat-sync decrypt-media 的已验证流程（自研实现，仅 node:crypto/spawn）：
// 1) 优先内嵌 JPEG/PNG 截取；2) 纯 HEVC 时切 NAL 流交外部 ffmpeg 转 JPEG 首帧
// ─────────────────────────────────────────────────────────────

/** HEVC NAL type（VPS=32，作为一段流的起点分组）。入参是**去掉起始码**的 NAL */
function hevcNalType(unit: Buffer): number {
  return unit.length ? (unit[0] >> 1) & 0x3f : -1
}

/**
 * 从 wxgf 载荷切出 NAL 单元（**payload 不含起始码**，>2 字节才收）。
 *
 * 为什么必须剔除起始码：早期实现把起始码一起切进 unit（`subarray(i, nalEnd)`），于是
 * `hevcNalType(unit)` 读到的永远是起始码首字节 0x00 —— 类型恒为 0，「按 VPS 分组」的分支
 * 从来没进过。一个 wxgf 里若装了两张图（微信常在真图前放一张纯白占位帧），就会被当成
 * 一整段交给 ffmpeg，而 `-vframes 1` 只解第一张 = 纯白图。实测本机 232 张 HEVC 默认图里
 * 42 张（18%）栽在这条上：配上 ffmpeg 反而得到白图，比原来的 180px 缩略图更糟。
 */
function extractHevcNaluUnits(buffer: Buffer): Buffer[] {
  const nalUnits: Buffer[] = []
  const push = (from: number, to: number): void => {
    if (to - from > 2) nalUnits.push(buffer.subarray(from, to))
  }
  let i = 4 // 'wxgf' 4 字节头
  while (i < buffer.length - 3) {
    const b = buffer
    let startCode = 0
    if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 0 && b[i + 3] === 1) startCode = 4
    else if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) startCode = 3
    if (startCode === 0) {
      i++
      continue
    }
    let nalEnd = buffer.length
    for (let j = i + startCode; j < buffer.length - 2; j++) {
      if (
        b[j] === 0 &&
        b[j + 1] === 0 &&
        (b[j + 2] === 1 || (b[j + 2] === 0 && j + 3 < buffer.length && b[j + 3] === 1))
      ) {
        nalEnd = j
        break
      }
    }
    push(i + startCode, nalEnd)
    i = nalEnd
  }
  if (nalUnits.length === 0) {
    // 无起始码：按首个起始码之后的裸流整体返回（payload 起点同样跳过起始码）
    for (let j = 4; j < buffer.length - 4; j++) {
      if (buffer[j] === 0 && buffer[j + 1] === 0 && buffer[j + 2] === 0 && buffer[j + 3] === 1) {
        return [buffer.subarray(j + 4)]
      }
    }
    return []
  }
  return nalUnits
}

/** NAL 按 VPS 分组拼成独立 Annex B 流（HEVC 转码的最小可解片段），过滤过小片段 */
export function extractHevcNaluStreams(buffer: Buffer): Buffer[] {
  const units = extractHevcNaluUnits(buffer)
  if (!units.length) return []
  const groups: Buffer[][] = []
  let current: Buffer[] = []
  for (const unit of units) {
    if (hevcNalType(unit) === 32 && current.length > 0) {
      groups.push(current)
      current = []
    }
    current.push(unit)
  }
  if (current.length > 0) groups.push(current)
  return groups
    .map((g) => Buffer.concat(g.map((u) => Buffer.concat([Buffer.from([0, 0, 0, 1]), u]))))
    .filter((s) => s.length >= 100)
}

/** 用外部 ffmpeg 将 HEVC 裸流转 JPEG 首帧；超时/失败返回 null（不抛错） */
export function convertHevcToJpeg(hevcData: Buffer, ffmpegPath: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        proc.kill()
      } catch {
        /* 进程已退出 */
      }
      resolve(null)
    }, 20000)
    const finish = (buf: Buffer | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(buf)
    }
    let proc
    try {
      proc = spawn(
        ffmpegPath,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'hevc',
          '-i',
          'pipe:0',
          '-vframes',
          '1',
          '-q:v',
          '3',
          '-f',
          'mjpeg',
          'pipe:1'
        ],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
      )
    } catch {
      finish(null)
      return
    }
    const chunks: Buffer[] = []
    proc.stdout.on('data', (c: Buffer) => chunks.push(c))
    proc.stderr.on('data', () => {
      /* 消费 stderr，防管道缓冲填满阻塞 */
    })
    proc.stdin.on('error', () => finish(null))
    proc.on('error', () => finish(null))
    proc.on('close', () => finish(chunks.length > 0 ? Buffer.concat(chunks) : null))
    proc.stdin.write(hevcData)
    proc.stdin.end()
  })
}

/** 小于这个字节数的解码结果视为无效帧（空白/半帧） */
export const WXGF_MIN_FRAME_BYTES = 1024

/** wxgf 取不到可视图片时的原因（调用方据此把「可修复」的失败讲清楚，而不是静默降级） */
export type WxgfViewableReason = 'not-wxgf' | 'no-ffmpeg' | 'decode-failed'

export interface WxgfViewableResult {
  data: Buffer | null
  reason?: WxgfViewableReason
  /** 成功时的来源：内嵌 JPEG/PNG，还是 HEVC 转码 */
  via?: 'embedded' | 'hevc'
}

/**
 * wxgf 载荷 → 可视图片数据：
 * 内嵌 JPEG/PNG 优先直接截取；纯 HEVC 流需 ffmpeg（ffmpegPath 为空则跳过返回 null）。
 *
 * 多段时**按载荷从大到小尝试，取第一个解得出帧的段**：占位帧的载荷只有几百字节，
 * 真图那段才是大的。早期写的是「按文件顺序、第一个解出 >1KB 的就返回」——占位帧解出来
 * 有 6~9KB，照样通过，于是把纯白图当成了结果（与上面 NAL 分组失效是同一个故障的两半）。
 */
export async function extractWxgfViewableDetailed(
  buf: Buffer,
  ffmpegPath: string | null
): Promise<WxgfViewableResult> {
  if (!isWxgf(buf)) return { data: null, reason: 'not-wxgf' }
  const embedded = extractEmbeddedImage(buf)
  if (embedded) return { data: embedded, via: 'embedded' }
  if (!ffmpegPath) return { data: null, reason: 'no-ffmpeg' }
  const streams = extractHevcNaluStreams(buf).sort((a, b) => b.length - a.length)
  if (streams.length === 0) return { data: null, reason: 'decode-failed' }
  for (const stream of streams) {
    const jpg = await convertHevcToJpeg(stream, ffmpegPath)
    if (jpg && jpg.length > WXGF_MIN_FRAME_BYTES) return { data: jpg, via: 'hevc' }
  }
  return { data: null, reason: 'decode-failed' }
}

/** 只要数据的老口径（保留给既有调用方与自检） */
export async function extractWxgfViewable(
  buf: Buffer,
  ffmpegPath: string | null
): Promise<Buffer | null> {
  return (await extractWxgfViewableDetailed(buf, ffmpegPath)).data
}
