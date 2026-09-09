/**
 * 文件名安全化(导出/归档/工作台会话/发布包共用)。
 * 各调用方通过选项保留自身原有的替换字符、长度上限与兜底名。
 */

/** 非法字符(含换行与制表符),连续出现时合并为一个替换字符 */
const ILLEGAL_RUN_RE = /[\\/:*?"<>|\r\n\t]+/g
/** 非法字符(逐个替换,不合并) */
const ILLEGAL_CHAR_RE = /[\\/:*?"<>|\r\n\t]/g

export interface SafeFileNameOptions {
  /** 非法字符的替换字符(默认 '_') */
  replacement?: string
  /** 结果长度上限(默认 80) */
  maxLength?: number
  /** 结果为空时的兜底名(默认 'file') */
  fallback?: string
  /** 是否去除首尾空白(默认 true) */
  trim?: boolean
  /** 连续非法字符是否合并为一个替换字符(默认 true) */
  collapse?: boolean
}

export function safeFileName(input: string, opts: SafeFileNameOptions = {}): string {
  const re = opts.collapse === false ? ILLEGAL_CHAR_RE : ILLEGAL_RUN_RE
  const replaced = String(input ?? '').replace(re, opts.replacement ?? '_')
  const cleaned = opts.trim === false ? replaced : replaced.trim()
  return cleaned.slice(0, opts.maxLength ?? 80) || (opts.fallback ?? 'file')
}
