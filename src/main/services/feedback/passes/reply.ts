import { getConfig } from '../../../db/repos/config'
import { runDutyPass } from '../../agent/duty'
import { issueLog, sleep } from './shared'

/**
 * 通道 D：数字员工值班（自动应答）。
 *
 * - 与问题引擎三条通道并列，但**开关独立**（agent.reply.enabled）：关掉问题自动扫描不该让值班停摆；
 * - 节奏随模式变化：影子期（只记录不发送）2 分钟一轮足够看效果；live（可发送）时每分钟一轮，
 *   保证客户等的时间尽量短；
 * - 群之间留间隔，避免一次性把 30 个群的分析挤在同一秒。
 */

/** 单账号在途保护：一轮没跑完不叠加下一轮 */
const running = new Set<string>()
/** 影子期最小间隔（ms） */
const SHADOW_MIN_GAP_MS = 110_000
/** live 期最小间隔（ms） */
const LIVE_MIN_GAP_MS = 50_000
/** 群与群之间的节奏间隔 */
const GROUP_PACE_MS = 150

const lastPassAt = new Map<string, number>()

export function resetReplyState(): void {
  running.clear()
  lastPassAt.clear()
}

export async function runReplyPass(wxid: string, opts: { force?: boolean } = {}): Promise<void> {
  if (running.has(wxid)) return
  const live = getConfig('agent.reply.defaultMode') === 'live'
  const gap = live ? LIVE_MIN_GAP_MS : SHADOW_MIN_GAP_MS
  const now = Date.now()
  if (!opts.force && now - (lastPassAt.get(wxid) ?? 0) < gap) return
  running.add(wxid)
  lastPassAt.set(wxid, now)
  try {
    const r = await runDutyPass(wxid)
    if (r.handoff > 0 || r.decided > 0 || r.llm > 0) {
      issueLog.info(
        `数字员工值班 ${wxid} 群=${r.groups} 扫=${r.scanned} 命中=${r.decided} 转人工=${r.handoff} 兜底=${r.llm} 不介入=${r.skipped}`
      )
    } else if (r.scanned > 0 || !r.ok) {
      issueLog.debug(`数字员工值班 ${wxid} 群=${r.groups} 扫=${r.scanned}（无需介入）`)
    }
    if (!r.ok && r.error) issueLog.warn(`数字员工值班失败 ${wxid}: ${r.error}`)
    await sleep(GROUP_PACE_MS)
  } catch (e) {
    issueLog.warn(`数字员工值班异常 ${wxid}: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    running.delete(wxid)
  }
}
