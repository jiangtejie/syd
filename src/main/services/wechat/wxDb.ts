/**
 * 微信库打开层（门面转发）。
 * 实际打开/解密实现见 decrypt.ts（T4 spike 确认微信 4.x 为魔改 SQLCipher）。
 */
export { openWxDbFile, type DecryptResult } from './decrypt'
export { testWxConnection, type OpenWxDbResult } from './wxDbCore'
