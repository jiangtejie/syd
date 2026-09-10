import { ipcMain } from 'electron'
import {
  getGroupSwitch,
  listGroupSwitches,
  setGroupSwitch,
  setGroupSwitches,
  clearGroupSwitch,
  type GroupReplyMode
} from '../db/repos/agentGroupRepo'
import {
  importScripts,
  listScripts,
  removeScript,
  saveScript,
  setScriptEnabled,
  type ReplyScriptInput
} from '../db/repos/replyScriptRepo'
import {
  listReplies,
  replyStats,
  setReplyFeedback,
  type ReplyStatus
} from '../db/repos/agentReplyRepo'
import { previewOnMessages, runDutyPass, dutyStatus } from '../services/agent/duty'
import { STARTER_SCRIPTS } from '../services/agent/starters'
import { isGroupExcluded } from '../services/feedback/groupScope'
import { isTeamMsg, msgToText, readGroupMessages } from '../services/feedback/shared'
import { enrichMessages, getSessions } from '../services/wechat/wxService'
import { getTeamUsernamesCached } from '../db/repos/teamRepo'
import type { ReplyScript } from '../db/repos/replyScriptRepo'
import { fail } from './_util'

/**
 * 数字员工（值班自动应答）IPC —— 命名空间 cs:duty:*。
 *
 * 与 cs:agent:*（AI 智能体 CRUD）区分：这里是「值班通道 + 话术库 + 群开关 + 决策记录」。
 * 一期只有影子模式（记录不发送），所以这里没有任何发送通道 —— 发送能力要等校准完再开。
 */

export function registerDutyHandlers(): void {
  // 值班总览：开关、模式、话术数、近 7 天决策分布
  ipcMain.handle('cs:duty:status', (_e, wxid: string) => {
    if (!wxid) return { ok: false as const, error: '缺少账号' }
    try {
      const status = dutyStatus(wxid)
      const stats = replyStats(wxid, Date.now() - 7 * 86_400_000)
      return { ok: true as const, status, stats }
    } catch (err) {
      return fail(err)
    }
  })

  // ── 话术库 ──
  ipcMain.handle('cs:duty:scripts', (_e, wxid: string) => {
    if (!wxid) return { ok: false as const, error: '缺少账号' }
    try {
      return { ok: true as const, scripts: listScripts(wxid) }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('cs:duty:scriptSave', (_e, wxid: string, input: ReplyScriptInput) => {
    if (!wxid) return { ok: false as const, error: '缺少账号' }
    try {
      const id = saveScript({ ...input, accountWxid: input.accountWxid ?? wxid })
      return { ok: true as const, id, scripts: listScripts(wxid) }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('cs:duty:scriptRemove', (_e, wxid: string, id: number) => {
    try {
      const removed = removeScript(id)
      return { ok: true as const, removed, scripts: wxid ? listScripts(wxid) : [] }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('cs:duty:scriptToggle', (_e, wxid: string, id: number, enabled: boolean) => {
    try {
      setScriptEnabled(id, enabled)
      return { ok: true as const, scripts: wxid ? listScripts(wxid) : [] }
    } catch (err) {
      return fail(err)
    }
  })

  /** 批量导入话术（模板粘贴 / JSON）；按 (账号+intent) 覆盖更新 */
  ipcMain.handle('cs:duty:scriptImport', (_e, wxid: string, rows: ReplyScriptInput[]) => {
    if (!wxid) return { ok: false as const, error: '缺少账号' }
    if (!Array.isArray(rows) || rows.length === 0) {
      return { ok: false as const, error: '没有可导入的话术' }
    }
    try {
      const stat = importScripts(wxid, rows)
      return { ok: true as const, ...stat, scripts: listScripts(wxid) }
    } catch (err) {
      return fail(err)
    }
  })

  /** 导入推荐话术（一期模板：只承诺动作、不承诺事实）；按 intent 幂等，重复点不会产生重复条目 */
  ipcMain.handle('cs:duty:seedStarters', (_e, wxid: string) => {
    if (!wxid) return { ok: false as const, error: '缺少账号' }
    try {
      const stat = importScripts(wxid, STARTER_SCRIPTS)
      return { ok: true as const, ...stat, scripts: listScripts(wxid) }
    } catch (err) {
      return fail(err)
    }
  })

  // ── 群开关（客户页批量管理用）──
  ipcMain.handle('cs:duty:groups', (_e, wxid: string) => {
    if (!wxid) return { ok: false as const, error: '缺少账号' }
    try {
      const switches = listGroupSwitches(wxid)
      const map: Record<string, { enabled: boolean; mode: GroupReplyMode; note: string }> = {}
      for (const s of switches) {
        map[s.groupUsername] = { enabled: s.enabled, mode: s.mode, note: s.note }
      }
      return { ok: true as const, switches: map }
    } catch (err) {
      return fail(err)
    }
  })

  /** 批量开关（客户页多选）：groups 为空数组 = 恢复默认（删差异行） */
  ipcMain.handle(
    'cs:duty:groupsSet',
    (
      _e,
      wxid: string,
      groups: string[],
      patch: { enabled?: boolean; mode?: GroupReplyMode; reset?: boolean }
    ) => {
      if (!wxid) return { ok: false as const, error: '缺少账号' }
      if (!Array.isArray(groups) || groups.length === 0) {
        return { ok: false as const, error: '未选择任何群' }
      }
      try {
        if (patch?.reset) {
          for (const g of groups) clearGroupSwitch(wxid, g)
        } else {
          setGroupSwitches(wxid, groups, { enabled: patch?.enabled, mode: patch?.mode })
        }
        const switches = listGroupSwitches(wxid)
        const map: Record<string, { enabled: boolean; mode: GroupReplyMode; note: string }> = {}
        for (const s of switches) {
          map[s.groupUsername] = { enabled: s.enabled, mode: s.mode, note: s.note }
        }
        return { ok: true as const, count: groups.length, switches: map }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle('cs:duty:groupOne', (_e, wxid: string, group: string) => {
    try {
      return { ok: true as const, sw: getGroupSwitch(wxid, group) }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(
    'cs:duty:groupSet',
    (
      _e,
      wxid: string,
      group: string,
      patch: { enabled?: boolean; mode?: GroupReplyMode; reset?: boolean }
    ) => {
      if (!wxid || !group) return { ok: false as const, error: '缺少账号或群标识' }
      try {
        if (patch?.reset) clearGroupSwitch(wxid, group)
        else setGroupSwitch(wxid, group, { enabled: patch?.enabled, mode: patch?.mode })
        return { ok: true as const, sw: getGroupSwitch(wxid, group) }
      } catch (err) {
        return fail(err)
      }
    }
  )

  // ── 决策记录（影子审核）──
  ipcMain.handle(
    'cs:duty:replies',
    (_e, wxid: string, opts: { status?: ReplyStatus; group?: string; limit?: number } = {}) => {
      if (!wxid) return { ok: false as const, error: '缺少账号' }
      try {
        return { ok: true as const, replies: listReplies(wxid, opts) }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle('cs:duty:feedback', (_e, id: number, feedback: string) => {
    try {
      setReplyFeedback(id, feedback)
      return { ok: true as const }
    } catch (err) {
      return fail(err)
    }
  })

  /** 手动跑一轮值班（影子期用来即时看效果，不等定时器） */
  ipcMain.handle('cs:duty:run', async (_e, wxid: string) => {
    if (!wxid) return { ok: false as const, error: '缺少账号' }
    try {
      const r = await runDutyPass(wxid)
      return { ok: true as const, result: r }
    } catch (err) {
      return fail(err)
    }
  })

  /**
   * 历史回放预演：拿过去 N 天的真实群消息跑一遍判定，**不写库、不发送**。
   * 这是校准工具 —— 上线前就能看到「它会对哪些消息回什么」，比等三天真实流量快得多。
   */
  ipcMain.handle(
    'cs:duty:preview',
    (_e, wxid: string, opts: { days?: number; limitGroups?: number } = {}) => {
      if (!wxid) return { ok: false as const, error: '缺少账号' }
      try {
        const days = Math.min(Math.max(Math.floor(opts.days ?? 2), 1), 7)
        const limitGroups = Math.min(Math.max(Math.floor(opts.limitGroups ?? 10), 1), 30)
        const now = Date.now()
        const windowStart = new Date(now).setHours(0, 0, 0, 0) - (days - 1) * 86_400_000
        const res = getSessions(wxid)
        if (!res.ok || !res.sessions) {
          return { ok: false as const, error: res.error || '会话列表读取失败' }
        }
        const switches = new Map(listGroupSwitches(wxid).map((s) => [s.groupUsername, s.enabled]))
        const groups = res.sessions
          .filter(
            (s) =>
              s.isGroup &&
              !s.isWeCom &&
              s.displayName.trim() !== '' &&
              s.lastTimestamp >= windowStart &&
              !isGroupExcluded(wxid, s.username) &&
              (switches.get(s.username) ?? true)
          )
          .sort((a, b) => b.lastTimestamp - a.lastTimestamp)
          .slice(0, limitGroups)
        const team = getTeamUsernamesCached(wxid)
        const byGroup: Array<{
          group: string
          name: string
          msgs: number
          decisions: number
          handoff: number
          nonText: number
        }> = []
        const samples: Array<{
          group: string
          groupName: string
          time: number
          sender: string
          text: string
          action: string
          intent: string
          reply: string
          reason: string
        }> = []
        for (const g of groups) {
          const read = readGroupMessages(wxid, g.username, windowStart, undefined, {
            enrich: false
          })
          const msgs = enrichMessages(wxid, g.username, read.msgs)
          const rows = previewOnMessages(wxid, msgs, g.displayName, team)
          const nonText = msgs.filter(
            (m) => !m.isSend && !isTeamMsg(m, team) && m.localType !== 1
          ).length
          byGroup.push({
            group: g.username,
            name: g.displayName,
            msgs: msgs.length,
            decisions: rows.filter((r) => r.action === 'reply').length,
            handoff: rows.filter((r) => r.action === 'handoff').length,
            nonText
          })
          for (const r of rows.slice(0, 20)) {
            samples.push({ group: g.username, groupName: g.displayName, ...r, time: r.time })
          }
        }
        // 按意图汇总（话术覆盖度：哪些话术真被需要、哪些场景还没有话术）
        const intentMap = new Map<string, number>()
        for (const s of samples) {
          if (s.action !== 'reply') continue
          const k = s.intent || '(未命名)'
          intentMap.set(k, (intentMap.get(k) ?? 0) + 1)
        }
        return {
          ok: true as const,
          days,
          groups: byGroup,
          samples: samples.sort((a, b) => b.time - a.time).slice(0, 200),
          intents: [...intentMap.entries()]
            .map(([intent, n]) => ({ intent, n }))
            .sort((a, b) => b.n - a.n),
          totals: {
            groups: byGroup.length,
            msgs: byGroup.reduce((a, b) => a + b.msgs, 0),
            decisions: byGroup.reduce((a, b) => a + b.decisions, 0),
            handoff: byGroup.reduce((a, b) => a + b.handoff, 0),
            nonText: byGroup.reduce((a, b) => a + b.nonText, 0)
          }
        }
      } catch (err) {
        return fail(err)
      }
    }
  )
}

/** 供类型引用：话术对象（渲染端只读展示用） */
export type DutyScript = ReplyScript
export { msgToText }
