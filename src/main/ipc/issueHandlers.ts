import { BrowserWindow, ipcMain } from 'electron'
import {
  analyzeGroupIssues,
  analyzeIssues,
  clearFeedbackIssues,
  clearGroupRunState,
  listFeedbackIssues,
  readState,
  updateIssueStatus,
  issueTypeCounts
} from '../services/feedback/analyzer'
import {
  getIssueDetail,
  listIssuesByGroup,
  countOpenByGroup,
  clearIssuesByGroup,
  setIssueAssignee,
  confirmIssueDoubt
} from '../db/repos/issueRepo'
import type { FeedbackIssueStatus } from '../../shared/types'

/**
 * 群问题反馈 IPC（看板 + 工作台）。
 * cs:issue:list / analyze / analyzeGroup / listGroup / state / detail / setStatus / typeCounts
 */

export function registerIssueHandlers(): void {
  /** 数据变更通知:监控/看板等页面据此同步刷新;added>0 表示本次新落库问题数(渲染端提醒用) */
  const notifyChanged = (extra: { wxid?: string; added?: number } = {}): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('cs:issue:changed', { at: Date.now(), ...extra })
    }
  }

  ipcMain.handle('cs:issue:list', (_e, wxid: string) => {
    if (!wxid) return { ok: false as const, error: '缺少账号' }
    try {
      return { ok: true as const, issues: listFeedbackIssues(wxid) }
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  })

  ipcMain.handle('cs:issue:analyze', async (_e, wxid: string) => {
    if (!wxid) return { ok: false as const, error: '缺少账号' }
    return analyzeIssues(wxid).then((r) => {
      notifyChanged()
      return r
    })
  })

  // 单群窗口分析（工作台「群问题」视图）：days 自然日窗口、自动触发带节流;reset=先清空该群待处理再重扫
  ipcMain.handle(
    'cs:issue:analyzeGroup',
    async (
      _e,
      wxid: string,
      groupUsername: string,
      groupName?: string,
      opts?: { days?: number; force?: boolean; reset?: boolean }
    ) => {
      if (!wxid || !groupUsername) return { ok: false as const, error: '缺少账号或群标识' }
      return analyzeGroupIssues(wxid, groupUsername, groupName ?? '', opts ?? {}).then((r) => {
        notifyChanged({
          wxid,
          added: r.ok && !r.skipped && r.count && r.count > 0 ? r.count : undefined
        })
        return r
      })
    }
  )

  // 某群的问题列表（工作台「群问题」视图本地读取，秒开）
  ipcMain.handle('cs:issue:listGroup', (_e, wxid: string, groupUsername: string) => {
    if (!wxid || !groupUsername) return { ok: false as const, error: '缺少账号或群标识' }
    try {
      return { ok: true as const, issues: listIssuesByGroup(wxid, groupUsername) }
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  })

  // 清空某群全部记录(含历史/证据)并复位该群分析状态——「从零开始」,不可恢复
  ipcMain.handle('cs:issue:clearGroup', (_e, wxid: string, groupUsername: string) => {
    if (!wxid || !groupUsername) return { ok: false as const, error: '缺少账号或群标识' }
    try {
      clearIssuesByGroup(wxid, groupUsername)
      clearGroupRunState(wxid, groupUsername)
      notifyChanged()
      return { ok: true as const }
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  })

  ipcMain.handle('cs:issue:state', (_e, wxid: string) => {
    return { ok: true as const, state: readState(wxid ?? '') }
  })

  ipcMain.handle('cs:issue:clear', (_e, wxid: string) => {
    if (!wxid) return { ok: false as const, error: '缺少账号' }
    try {
      clearFeedbackIssues(wxid)
      notifyChanged()
      return { ok: true as const }
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  })

  ipcMain.handle('cs:issue:setStatus', (_e, id: number, status: FeedbackIssueStatus) => {
    if (!Number.isInteger(id)) return { ok: false as const, error: '参数错误' }
    const valid: FeedbackIssueStatus[] = ['open', 'done', 'stalled', 'archived']
    if (!valid.includes(status)) return { ok: false as const, error: '非法状态' }
    try {
      updateIssueStatus(id, status)
      notifyChanged()
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:issue:detail', (_e, id: number) => {
    if (!Number.isInteger(id)) return { ok: false as const, error: '参数错误' }
    const detail = getIssueDetail(id)
    return detail
      ? { ok: true as const, issue: detail }
      : { ok: false as const, error: '问题不存在' }
  })

  // 指派跟进人（username 为团队客服成员；空/缺失 = 取消指派，成员名单由 cs:team 维护）
  ipcMain.handle('cs:issue:assign', (_e, id: number, username: string | null) => {
    if (!Number.isInteger(id)) return { ok: false as const, error: '参数错误' }
    try {
      if (!setIssueAssignee(id, username)) return { ok: false as const, error: '问题不存在' }
      notifyChanged()
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // 疑似确认：人工核实为真问题 → 清除疑似标记，正式进入待办口径
  ipcMain.handle('cs:issue:confirmDoubt', (_e, id: number) => {
    if (!Number.isInteger(id)) return { ok: false as const, error: '参数错误' }
    try {
      if (!confirmIssueDoubt(id)) return { ok: false as const, error: '问题不存在' }
      notifyChanged()
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:issue:typeCounts', (_e, wxid: string) => {
    if (!wxid) return { ok: false as const, error: '缺少账号' }
    return { ok: true as const, counts: issueTypeCounts(wxid) }
  })

  // 按群聚合 open 计数（工作台会话列表「待处理」徽标）
  ipcMain.handle('cs:issue:groupBadges', (_e, wxid: string) => {
    if (!wxid) return { ok: false as const, error: '缺少账号' }
    try {
      return { ok: true as const, badges: countOpenByGroup(wxid) }
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  })
}
