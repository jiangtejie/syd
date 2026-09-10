import { BrowserWindow } from 'electron'
import { getConfig } from '../../../db/repos/config'
import { createLogger } from '../../logging'

/**
 * 后台巡检三条通道的公共件：开关读取、日志、广播、节流工具。
 *
 * 通道分工（各自一个模块，见 extract / settle / escalate）：
 * - extract：新消息 → 增量提取（会调 LLM，受水位与 2 分钟节流约束）
 * - settle ：每 2 分钟对**有 open 问题的群**做规则跟进/收尾判定 + 高置信去重（零 LLM）
 * - escalate：盯办升级提醒（未指派/已指派未处理/跟进超时 → 应用内 + 飞书，带递增退避）
 */

export const issueLog = createLogger('issue')

/** 后台自动增量提取总开关（关闭后三条通道全部停下，手动分析仍可用） */
export const AUTO_SCAN_KEY = 'issue.autoScan.enabled'
/** 高置信重复议题自动合并开关 */
export const AUTO_MERGE_KEY = 'issue.autoMergeDuplicates'
/** 盯办升级提醒开关 */
export const ESCALATE_KEY = 'issue.escalate.enabled'
export const ESCALATE_UNASSIGNED_KEY = 'issue.escalateUnassignedHours'
export const ESCALATE_URGENT_KEY = 'issue.escalateUrgentHours'
export const ESCALATE_ASSIGNED_KEY = 'issue.escalateAssignedHours'

export const autoScanEnabled = (): boolean => getConfig(AUTO_SCAN_KEY) !== '0'
export const autoMergeEnabled = (): boolean => getConfig(AUTO_MERGE_KEY) !== '0'
export const escalateEnabled = (): boolean => getConfig(ESCALATE_KEY) !== '0'

/** 读小时级阈值（非法/缺失回落默认） */
export function cfgHours(key: string, fallback: number): number {
  const n = Number(getConfig(key))
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/** 数据变更广播：渲染端据此刷新列表/徽标；added=新问题数，escalate=盯办条数，settled=收尾写入条数 */
export function sendChanged(
  wxid: string,
  extra: { added?: number; escalate?: number; settled?: number }
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('cs:issue:changed', { at: Date.now(), wxid, ...extra })
  }
}

/** LLM 通道之间的节奏间隔（别把通道打满） */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
