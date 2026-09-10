import { useCallback, useEffect, useState } from 'react'
import type { ImAuditEntry } from '../../../../shared/types'

/**
 * IM 审计/任务的屏幕侧共用逻辑:轮询取数 + 时间/耗时可读化。
 * 任务面板与审计面板读同一张 im_audit,只有筛选口径与展示字段不同,故共用取数。
 * (与展示组件分文件:react-refresh 要求组件文件只导出组件。)
 */

const api = window.api?.cs?.feishuNotify

/** 轮询审计/任务(onlyTasks=true 只看任务,false 含被拒消息) */
export function useAuditPolling(
  limit: number,
  onlyTasks: boolean,
  intervalMs = 10_000
): { logs: ImAuditEntry[] | null; err: string } {
  const [logs, setLogs] = useState<ImAuditEntry[] | null>(null)
  const [err, setErr] = useState('')

  const load = useCallback(async (): Promise<void> => {
    const r = await api?.listAudit(limit, onlyTasks).catch(() => null)
    if (!r?.ok) {
      setErr(r?.error ?? '读取记录失败')
      return
    }
    setErr('')
    setLogs(r.logs ?? [])
  }, [limit, onlyTasks])

  useEffect(() => {
    let alive = true
    void api
      ?.listAudit(limit, onlyTasks)
      .then((r) => {
        if (!alive) return
        if (!r?.ok) {
          setErr(r?.error ?? '读取记录失败')
          return
        }
        setErr('')
        setLogs(r.logs ?? [])
      })
      .catch(() => undefined)
    const timer = setInterval(() => void load(), intervalMs)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [limit, onlyTasks, intervalMs, load])

  return { logs, err }
}

/** 时间(MM-DD HH:mm[:ss]) */
export function fmtAuditTime(ts: number, withSeconds = false): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  const base = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  return withSeconds ? `${base}:${p(d.getSeconds())}` : base
}

/** 耗时可读化(s/m) */
export function fmtAuditDur(from: number, to: number | null): string {
  const ms = (to ?? Date.now()) - from
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}
