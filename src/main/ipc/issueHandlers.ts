import { ipcMain } from 'electron'
import {
  analyzeIssues,
  clearFeedbackIssues,
  listFeedbackIssues,
  readState,
  updateIssueStatus,
  issueTypeCounts
} from '../services/feedback/analyzer'
import { getIssueDetail } from '../db/repos/issueRepo'
import type { FeedbackIssueStatus } from '../../shared/types'

/**
 * 群问题反馈 IPC（看板）。
 * cs:issue:list / analyze / state / detail / setStatus / typeCounts
 */

export function registerIssueHandlers(): void {
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
    return analyzeIssues(wxid)
  })

  ipcMain.handle('cs:issue:state', (_e, wxid: string) => {
    return { ok: true as const, state: readState(wxid ?? '') }
  })

  ipcMain.handle('cs:issue:clear', (_e, wxid: string) => {
    if (!wxid) return { ok: false as const, error: '缺少账号' }
    try {
      clearFeedbackIssues(wxid)
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

  ipcMain.handle('cs:issue:typeCounts', (_e, wxid: string) => {
    if (!wxid) return { ok: false as const, error: '缺少账号' }
    return { ok: true as const, counts: issueTypeCounts(wxid) }
  })
}
