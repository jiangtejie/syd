import { BrowserWindow, ipcMain } from 'electron'
import {
  analyzeGroupIssues,
  analyzeIssues,
  cancelIssuesAnalysis,
  clearFeedbackIssues,
  clearGroupRunState,
  listFeedbackIssues,
  mergeDuplicateIssues,
  readState,
  setIssueProgressSink,
  updateIssueStatus
} from '../services/feedback/analyzer'
import {
  archiveOpenIssuesByGroup,
  archiveResolvedBefore,
  getIssueDetail,
  groupSenders,
  listIssuesByGroup,
  countOpenByGroup,
  clearIssuesByGroup,
  setIssueAssignee,
  confirmIssueDoubt
} from '../db/repos/issueRepo'
import { isGroupExcluded, setGroupExcluded } from '../services/feedback/groupScope'
import { computeMonitorData } from '../../shared/monitorMetrics'
import type { FeedbackIssueStatus } from '../../shared/types'
import { createLogger } from '../services/logging'
import { fail } from './_util'

/** 维护类操作的调用留痕：按钮点了没反应时，先看「设置 → 日志」里 IPC 有没有到主进程 */
const issueLog = createLogger('issue')

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
  // 全量重析进度出口（30 个群串行可能几分钟）：analyzer 只管回调，推送交给 IPC 层
  setIssueProgressSink((p) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('cs:issue:progress', p)
    }
  })

  /** 默认返回行数上限：历史越长全量过 IPC 越贵，KPI 已在主进程算好，明细超限即截断并告知 */
  const OVERVIEW_LIMIT = 1000

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

  /**
   * 监控总览：KPI/趋势/分布**在主进程按全量数据算**，只把上限内的明细行过 IPC。
   * 之前渲染端每收到一次数据变更通知就拉一次全量问题（历史累积后单次可达数 MB）。
   */
  ipcMain.handle(
    'cs:issue:overview',
    (_e, wxid: string, opts?: { rangeDays?: number; backlogHours?: number; limit?: number }) => {
      if (!wxid) return { ok: false as const, error: '缺少账号' }
      try {
        const all = listFeedbackIssues(wxid)
        const rangeDays = Math.min(Math.max(Math.floor(opts?.rangeDays ?? 7), 1), 90)
        const metrics = computeMonitorData(all, rangeDays, {
          backlogHours: opts?.backlogHours ?? 48
        })
        const limit = Math.min(Math.max(Math.floor(opts?.limit ?? OVERVIEW_LIMIT), 1), 5000)
        return {
          ok: true as const,
          metrics,
          issues: all.slice(0, limit),
          total: all.length,
          loaded: Math.min(all.length, limit),
          truncated: all.length > limit
        }
      } catch (err) {
        return fail(err)
      }
    }
  )

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

  // 某群的问题列表（工作台「群问题」视图本地读取，秒开）；excluded=该群是否已排除监控
  ipcMain.handle('cs:issue:listGroup', (_e, wxid: string, groupUsername: string) => {
    if (!wxid || !groupUsername) return { ok: false as const, error: '缺少账号或群标识' }
    try {
      return {
        ok: true as const,
        issues: listIssuesByGroup(wxid, groupUsername),
        excluded: isGroupExcluded(wxid, groupUsername)
      }
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  })

  // 本群发言人（非我方、非团队）：供「批量标记同事」，未标记的同事会被当成客户
  ipcMain.handle('cs:issue:groupSenders', (_e, wxid: string, groupUsername: string) => {
    if (!wxid || !groupUsername) return { ok: false as const, error: '缺少账号或群标识' }
    try {
      return { ok: true as const, senders: groupSenders(wxid, groupUsername) }
    } catch (err) {
      return fail(err)
    }
  })

  /**
   * 群级参与开关：excluded=true 该群不再参与自动分析（后台增量 / 收尾巡检 / 全量重析）；
   * archiveOpen=true 时顺带把现有 open 记录归档（archived_from='excluded'，可重新打开）。
   */
  ipcMain.handle(
    'cs:issue:setGroupScope',
    (
      _e,
      wxid: string,
      groupUsername: string,
      excluded: boolean,
      opts?: { archiveOpen?: boolean }
    ) => {
      if (!wxid || !groupUsername) return { ok: false as const, error: '缺少账号或群标识' }
      try {
        setGroupExcluded(wxid, groupUsername, !!excluded)
        const archived =
          excluded && opts?.archiveOpen
            ? archiveOpenIssuesByGroup(wxid, groupUsername, 'excluded')
            : 0
        issueLog.info(
          `群级监控开关 ${wxid} ${groupUsername} excluded=${!!excluded} 归档=${archived}`
        )
        notifyChanged({ wxid })
        return { ok: true as const, archived, excluded: !!excluded }
      } catch (err) {
        return fail(err)
      }
    }
  )

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

  // 取消正在跑的全量重析（按群边界停下，已扫过的群结果保留）
  ipcMain.handle('cs:issue:cancel', (_e, wxid: string) => {
    if (!wxid) return { ok: false as const, error: '缺少账号' }
    cancelIssuesAnalysis(wxid)
    return { ok: true as const }
  })

  // 存量去重：合并历史锚点漂移留下的重复议题（dryRun 先给方案供 UI 预览确认）
  ipcMain.handle('cs:issue:mergeDuplicates', (_e, wxid: string, dryRun?: boolean) => {
    if (!wxid) return { ok: false as const, error: '缺少账号' }
    try {
      const r = mergeDuplicateIssues(wxid, { dryRun: !!dryRun })
      issueLog.info(`重复议题${dryRun ? '预览' : '合并'} ${wxid} 组=${r.clusters} 冗余=${r.merged}`)
      if (!dryRun && r.merged > 0) notifyChanged({ wxid })
      return { ok: true as const, ...r }
    } catch (err) {
      issueLog.error('重复议题合并失败', err)
      return fail(err)
    }
  })

  // 归档 N 天前已闭环记录：活跃列表/盯办/徽标只留近期，闭环率与趋势照旧统计
  ipcMain.handle('cs:issue:archiveStale', (_e, wxid: string, days: number) => {
    if (!wxid) return { ok: false as const, error: '缺少账号' }
    try {
      const archived = archiveResolvedBefore(wxid, Number(days) || 90)
      issueLog.info(`历史归档 ${wxid} days=${Number(days) || 90} 条数=${archived}`)
      if (archived > 0) notifyChanged({ wxid })
      return { ok: true as const, archived }
    } catch (err) {
      return fail(err)
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
      return fail(err)
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
      return fail(err)
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
      return fail(err)
    }
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
