import { useEffect, useState } from 'react'
import type { TeamMemberInfo } from '../../../shared/types'

interface TeamNamesState {
  /** 数据所属账号：与当前 wxid 不一致时一律按「还没加载」处理（切账号不会串名） */
  wxid: string
  members: TeamMemberInfo[]
  names: Record<string, string>
}

const EMPTY: TeamNamesState = { wxid: '', members: [], names: {} }

/**
 * 团队成员 + 跟进人展示名解析（监控页/群问题面板共用）。
 * 展示名优先级：成员备注 label > 微信联系人备注/昵称 > username。
 * reloadKey 变化时重新拉取（例如右键新增/移除团队成员之后）。
 */
export function useTeamNames(
  wxid: string | null | undefined,
  reloadKey?: unknown
): {
  members: TeamMemberInfo[]
  /** username → 展示名（空值返回空串；数据未就绪时回落 username） */
  nameOf: (username?: string) => string
} {
  const [state, setState] = useState<TeamNamesState>(EMPTY)

  useEffect(() => {
    const teamApi = window.api?.cs?.team
    if (!wxid || !teamApi) return
    let alive = true
    void (async () => {
      const res = await teamApi.list(wxid).catch(() => null)
      if (!alive) return
      const members = res?.ok && res.members ? (res.members as TeamMemberInfo[]) : []
      let names: Record<string, string> = {}
      const need = members.filter((m) => !(m.label ?? '').trim()).map((m) => m.username)
      if (need.length > 0) {
        const nr = await window.api?.cs?.wx?.contactNames?.(wxid, need).catch(() => null)
        if (!alive) return
        if (nr?.ok && nr.names) names = nr.names
      }
      setState({ wxid, members, names })
    })()
    return () => {
      alive = false
    }
  }, [wxid, reloadKey])

  const ready = !!wxid && state.wxid === wxid
  const members = ready ? state.members : []
  const nameOf = (username?: string): string => {
    const u = (username ?? '').trim()
    if (!u) return ''
    if (!ready) return u
    const m = state.members.find((x) => x.username === u)
    if (m && (m.label ?? '').trim()) return m.label ?? ''
    return state.names[u] || u
  }
  return { members, nameOf }
}
