import { readFileSync } from 'node:fs'
import crypto from 'node:crypto'

const XOR_KEY = 0x3b
const AES_KEY = Buffer.from('226d977de8d95941', 'ascii') // 16 字节，与 CipherTalk/chat-sync 配置一致

function bytesToInt32(bytes) {
  return bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)
}
function strictRemovePadding(data) {
  const paddingLength = data[data.length - 1]
  if (paddingLength === 0 || paddingLength > 16 || paddingLength > data.length) throw new Error('PKCS7 填充非法')
  for (let i = data.length - paddingLength; i < data.length; i++) {
    if (data[i] !== paddingLength) throw new Error('PKCS7 填充内容非法')
  }
  return data.subarray(0, data.length - paddingLength)
}
function decryptDatV4(filePath) {
  const bytes = readFileSync(filePath)
  if (bytes.length < 0x0f) throw new Error('文件太小')
  const data = bytes.subarray(0x0f)
  const aesSize = bytesToInt32(bytes.subarray(6, 10))
  const xorSize = bytesToInt32(bytes.subarray(10, 14))
  const remainder = ((aesSize % 16) + 16) % 16
  const alignedAesSize = aesSize + (16 - remainder)
  if (alignedAesSize > data.length) throw new Error('AES 数据长度超限')
  const aesData = data.subarray(0, alignedAesSize)
  let unpadded = Buffer.alloc(0)
  if (aesData.length > 0) {
    const decipher = crypto.createDecipheriv('aes-128-ecb', AES_KEY, null)
    decipher.setAutoPadding(false)
    const decrypted = Buffer.concat([decipher.update(aesData), decipher.final()])
    unpadded = strictRemovePadding(decrypted)
  }
  const remaining = data.subarray(alignedAesSize)
  if (xorSize < 0 || xorSize > remaining.length) throw new Error('XOR 长度不合法')
  let rawData = Buffer.alloc(0), xoredData = Buffer.alloc(0)
  if (xorSize > 0) {
    const rawLength = remaining.length - xorSize
    rawData = remaining.subarray(0, rawLength)
    const xorData = remaining.subarray(rawLength)
    xoredData = Buffer.alloc(xorData.length)
    for (let i = 0; i < xorData.length; i++) xoredData[i] = xorData[i] ^ XOR_KEY
  } else {
    rawData = remaining
  }
  return Buffer.concat([unpadded, rawData, xoredData])
}

function detectExt(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg'
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png'
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return '.gif'
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return '.webp'
  return null
}

const root = 'C:\\Users\\Administrator\\Documents\\xwechat_files\\wxid_r9l5xuni9ng522_7e0b\\msg\\attach'
const files = [
  `${root}\\de8583b6964a738222b0c1ccfc620392\\2026-08\\Img\\9c429ee38bdeab8a930b9ae221ec4d09.dat`,
  `${root}\\de8583b6964a738222b0c1ccfc620392\\2026-08\\Img\\9c429ee38bdeab8a930b9ae221ec4d09_t.dat`
]
for (const f of files) {
  const head = readFileSync(f).subarray(0, 6)
  const isV4 = head[0] === 0x07 && head[1] === 0x08 && head[2] === 0x56
  try {
    const buf = isV4 ? decryptDatV4(f) : readFileSync(f)
    const ext = detectExt(buf)
    console.log(`[${isV4 ? 'V4' : 'V3'}] ${f.split('\\').pop()} -> ${ext || '未知'} (${buf.length}B) 头=${buf.subarray(0, 4).toString('hex')}`)
  } catch (e) {
    console.log(`[FAIL] ${f.split('\\').pop()}: ${e.message}`)
  }
}
