import { useEffect, useState } from 'react'
import type { SessionSummary } from '../../../shared/types'
import { useWorkbenchStore } from '../stores/workbench'

/**
 * 会话头像：contact 远程 URL 优先；无 URL 或远程加载失败时，走 IPC 取 head_image 本地头像
 * （失败后 localOnly 强制本地，避免重复拿同一个坏链接）。
 * 渲染期只读模块缓存（不发副作用），IPC 结果经异步回调落地，不在 effect 内同步 setState。
 */
const avatarCache = new Map<string, string | null>()

export function useSessionAvatar(session: SessionSummary): {
  avatarUrl?: string
  markUrlFailed: () => void
} {
  const wxid = useWorkbenchStore((s) => s.wxid)
  const source = useWorkbenchStore((s) => s.source)
  const [remoteFailed, setRemoteFailed] = useState(false)
  const [localFallback, setLocalFallback] = useState<string | null>(
    () => avatarCache.get(`${session.username}::local`) ?? null
  )
  const hasUrl = !!session.avatarUrl && /^(https?:|data:image)/.test(session.avatarUrl)
  const needLocal = !hasUrl || remoteFailed
  const cacheKey = remoteFailed ? `${session.username}::local` : session.username

  useEffect(() => {
    if (!needLocal || source !== 'wx' || !wxid || !session.username) return
    if (avatarCache.has(cacheKey)) return
    let alive = true
    window.api?.cs?.wx
      ?.getAvatar?.(wxid, session.username, remoteFailed)
      .then((res) => {
        if (!alive) return
        const u = res?.ok && res.url ? res.url : null
        avatarCache.set(cacheKey, u)
        setLocalFallback(u)
      })
      .catch(() => {
        if (alive) avatarCache.set(cacheKey, null)
      })
    return () => {
      alive = false
    }
  }, [needLocal, remoteFailed, session.username, wxid, source, cacheKey])

  // 优先远程 URL；失败/缺失后取本地（模块缓存即时可用，state 兜底）
  const avatarUrl =
    hasUrl && !remoteFailed
      ? session.avatarUrl
      : (avatarCache.get(cacheKey) ?? localFallback ?? undefined)
  return { avatarUrl, markUrlFailed: () => setRemoteFailed(true) }
}
