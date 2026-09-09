import { createHash } from 'node:crypto'

/** 去重键兜底:内容 sha1 摘要(前 16 位十六进制) */
export function sha1Of(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 16)
}
