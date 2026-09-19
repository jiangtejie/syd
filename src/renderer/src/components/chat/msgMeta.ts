/**
 * 对话回复相关的纯逻辑：meta 解析、思考/Token/引用来源的取值、复制、计时。
 * 与 RichText.tsx 分开是为了让组件文件只导出组件（react-refresh 的 only-export-components）。
 */

import { useEffect, useRef, useState } from 'react'

/** 消息 meta → 对象。chat_message.meta 落库是 JSON 字符串（老行可能是对象），两种都认；
 * 解析失败一律当没有，别让一条脏 meta 把整条回复渲染挂掉。 */
export function parseMsgMeta(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw) as unknown
      return p && typeof p === 'object' ? (p as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  return typeof raw === 'object' ? (raw as Record<string, unknown>) : null
}

/** 思考文本与耗时（终稿存在 meta 里，只有 AI 的正文回复才有） */
export function reasoningOf(meta: Record<string, unknown> | null): { text: string; ms?: number } {
  const text = typeof meta?.reasoning === 'string' ? meta.reasoning : ''
  const ms = typeof meta?.reasoningMs === 'number' ? meta.reasoningMs : undefined
  return { text, ms }
}

export interface Tokens {
  input?: number
  output?: number
}

/** Token 用量（meta.tokens） */
export function tokensOf(meta: Record<string, unknown> | null): Tokens | undefined {
  const t = meta?.tokens as Tokens | undefined
  return t && (typeof t.input === 'number' || typeof t.output === 'number') ? t : undefined
}

/** 引用来源条目（meta.evidence 快照：编号 + 工具名 + 行原文） */
export interface EvItem {
  n: number
  tool: string
  line: string
}

/** 证据条目做形状校验后再用：脏数据只是少显示几条，不能让整段回复崩掉 */
export function evidenceOf(meta: Record<string, unknown> | null): EvItem[] {
  const raw = meta?.evidence
  if (!Array.isArray(raw)) return []
  const out: EvItem[] = []
  for (const it of raw) {
    if (out.length >= 12) break
    if (!it || typeof it !== 'object') continue
    const r = it as Record<string, unknown>
    if (
      typeof r.n === 'number' &&
      typeof r.tool === 'string' &&
      r.tool.length > 0 &&
      typeof r.line === 'string' &&
      r.line.length > 0
    ) {
      out.push({ n: r.n, tool: r.tool, line: r.line })
    }
  }
  return out
}

/** 复制到剪贴板（navigator.clipboard 失败时回退 execCommand） */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    /* fallthrough */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}

/** 数字 → 千分位（大数值更易读） */
export function fmtThousand(n: number): string {
  return Math.round(n).toLocaleString('zh-CN')
}

/** 耗时(ms) → 人类可读（秒/分） */
export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return String(s) + ' 秒'
  return String(Math.floor(s / 60)) + ' 分 ' + String(s % 60) + ' 秒'
}

/** 等待态计时（思考/等待首字期间）：active 变 true 起计时，false 复位 */
export function useWaitElapsed(active: boolean): number {
  const [sec, setSec] = useState(0)
  const startRef = useRef<number | null>(null)
  useEffect(() => {
    if (!active) {
      startRef.current = null
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 等待结束复位秒数(全仓同款模式)
      setSec(0)
      return
    }
    if (startRef.current === null) startRef.current = Date.now()
    const tick = (): void => {
      if (startRef.current !== null) setSec(Math.floor((Date.now() - startRef.current) / 1000))
    }
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [active])
  return sec
}
