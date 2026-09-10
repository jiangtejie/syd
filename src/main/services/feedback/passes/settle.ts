import { mergeDuplicateIssues, reconcileGroupFollowups } from '../analyzer'
import { hasDuplicateCandidates, openGroupUsernames } from '../../../db/repos/issueRepo'
import { autoMergeEnabled, autoScanEnabled, issueLog, sendChanged } from './shared'

/**
 * 通道 B：收尾巡检（零 LLM）。
 *
 * 为什么必须独立于增量提取：静默收尾的前提恰恰是「群里没有新消息」，
 * 而增量提取在「水位后无新消息」时直接 skip（连消息都不读），永远走不到收尾判定。
 * 又因为跟进状态要「有人回复就尽快变」，这里按 2 分钟一轮（入口用 tick 计数控制），
 * 只读消息 + 判定，不调模型。
 *
 * 同一轮顺带做**高置信重复议题自动合并**：只有证据几乎完全重合 / 标题逐字一致这类强信号才自动并，
 * 组内多人跟进时不并；弱信号一律留给监控页「重复合并」人工预览。
 */

const running = new Set<string>()

/** 一轮收尾巡检：跟进/收尾判定 + 高置信去重；只在真的发生写入时广播 */
export async function runSettlePass(wxid: string): Promise<void> {
  if (running.has(wxid) || !autoScanEnabled()) return
  running.add(wxid)
  try {
    // 只取「有 open 问题的群名」（一条 DISTINCT 查询），不必把全部历史问题拉出来装饰一遍
    const groups = new Set(openGroupUsernames(wxid))
    if (groups.size === 0) return
    let changed = 0
    for (const g of groups) {
      try {
        changed += reconcileGroupFollowups(wxid, g).changed
      } catch (e) {
        issueLog.warn(`收尾巡检失败 ${wxid} ${g}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    // 前置：没有「同群 ≥2 条 open」就跳过聚类，避免每轮做无用功
    if (autoMergeEnabled() && hasDuplicateCandidates(wxid)) {
      try {
        const m = mergeDuplicateIssues(wxid, { strongOnly: true })
        if (m.merged > 0) {
          changed += m.merged
          issueLog.info(
            `自动合并重复议题 ${wxid} 组=${m.clusters} 归档=${m.merged} ` +
              `明细=${m.plan.map((x) => `${x.keepId}<-${x.dropIds.join('+')}`).join(',')}`
          )
        }
      } catch (e) {
        issueLog.warn(`自动合并重复议题失败 ${wxid}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (changed > 0) {
      sendChanged(wxid, { settled: changed })
      issueLog.debug(`收尾巡检 ${wxid} groups=${groups.size} changed=${changed}`)
    }
  } finally {
    running.delete(wxid)
  }
}

/** 停止调度时清空进程内状态 */
export function resetSettleState(): void {
  running.clear()
}
