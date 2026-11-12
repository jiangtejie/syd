import { useCallback, useEffect, useState } from 'react'
import type { ImAuditEntry } from '../../../../shared/types'
import { fmtDuration } from '../../lib/toolTimeline'

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

/** 时间(MM-DD HH:mm:ss；withSeconds=false 才省秒 —— 默认给秒，审计对时间要精确) */
export function fmtAuditTime(ts: number, withSeconds = true): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  const base = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  return withSeconds ? `${base}:${p(d.getSeconds())}` : base
}

/** 耗时可读化：口径与工具时间线共用一份（此前这里输出 `1m3s`、那边 `1m03s`，同一时长两种写法） */
export function fmtAuditDur(from: number, to: number | null): string {
  return fmtDuration((to ?? Date.now()) - from, false)
}
