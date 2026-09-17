import { getConfig, getConfigBoolean } from '../../db/repos/config'
import { bumpScriptHit, listScripts } from '../../db/repos/replyScriptRepo'
import {
  getDutyState,
  listGroupSwitches,
  saveDutyState,
  type GroupReplyMode
} from '../../db/repos/agentGroupRepo'
import { countRepliesMissingIntent, insertReply } from '../../db/repos/agentReplyRepo'
import { getTeamUsernamesCached } from '../../db/repos/teamRepo'
import { isGroupExcluded } from '../feedback/groupScope'
import { isMachineReadable, isTeamMsg, msgToText, readGroupMessages } from '../feedback/shared'
import { enrichMessages, getSessions } from '../wechat/wxService'
import { decorateVoiceTranscripts } from '../media/voiceTranscript'
import { generateSuggestions } from '../ai/suggest'
import { fmtStamp } from '../../../shared/monitorMetrics'
import { matchReply } from './matcher'
import { classifyIntent, classifyIntentByRules } from './intent'
import { createLogger } from '../logging'
import type { ChatMessage } from '../../../shared/types'

const dutyLog = createLogger('duty')

/**
 * 数字员工 · 值班通道（一期：影子模式）。
 *
 * 每轮：候选客户群 → 读增量消息 → 判定该不该回（matcher，纯函数）→ 记录决策。
 * **一期只记录不发送**：先让人看「它打算怎么回」，用真实消息校准话术与风险分级，
 * 校准到位再切 live（二期）。所有判定结果都落 agent_reply，可逐条复盘。
 *
 * 与议题引擎的关系：互不干扰、各自水位。议题引擎判断「这是不是一个要跟的问题」，
 * 值班通道判断「这条消息要不要回、怎么回」；同事已回复时两边都会退让（同一份团队名单）。
 */

/** 全局开关（默认开：影子模式不发消息，开着才有数据可校准） */
export const CFG_ENABLED = 'agent.reply.enabled'
/** 影子模式下是否调用 LLM 生成兜底草稿（默认开，能看出话术覆盖不到时它会怎么答） */
export const CFG_SHADOW_LLM = 'agent.shadowLlm'

/** 首轮回溯窗口：新群/新账号不要一上来就把三天历史全决策一遍 */
const INIT_LOOKBACK_MS = 30 * 60_000
/** 单群决策冷却：客户连发多条时合并成一次（人工也是这么答的） */
const COOLDOWN_MS = 90_000
/** 触发文本合并上限（条） */
const TRIGGER_MAX_MSGS = 5
/** 单轮 LLM 兜底上限（控制成本；影子期够看效果） */
const LLM_CAP_PER_PASS = 5
/** 单轮最多看多少个群 */
const MAX_GROUPS = 30

export interface DutyPassResult {
  ok: boolean
  error?: string
  /** 候选群数（已开启自动回复的客户群） */
  groups: number
  /** 本轮纳入判定的消息条数 */
  scanned: number
  /** 命中话术、已记录待发 */
  decided: number
  /** 高风险转人工 */
  handoff: number
  /** 未命中话术、走了 LLM 兜底 */
  llm: number
  /** 判定为无需介入（我方发言/纯应答/通知等） */
  skipped: number
}

/** 该群是否开启自动回复：显式配置优先，否则跟随全局默认 */
function groupEnabled(group: string, switches: Map<string, boolean>): boolean {
  const hit = switches.get(group)
  if (hit !== undefined) return hit
  return getConfigBoolean('agent.reply.defaultEnabled', true)
}

export function defaultMode(): GroupReplyMode {
  return getConfig('agent.reply.defaultMode') === 'live' ? 'live' : 'shadow'
}

/** 值日周期内该群最近一次决策时间（用于冷却；agent_reply 里查一次即可） */
function lastDecisionAt(state: ReturnType<typeof getDutyState>): number {
  return state?.lastRunAt ?? 0
}

/** 合并触发文本：客户连发的多条消息合成一次判定（截断保护，避免超长 prompt） */
function mergeTrigger(msgs: ChatMessage[]): string {
  return msgs
    .slice(-TRIGGER_MAX_MSGS)
    .map((m) => msgToText(m).slice(0, 200))
    .filter(Boolean)
    .join('\n')
}

export async function runDutyPass(
  wxid: string,
  opts: { now?: number; groups?: Array<{ username: string; displayName: string }> } = {}
): Promise<DutyPassResult> {
  const out: DutyPassResult = {
    ok: true,
    groups: 0,
    scanned: 0,
    decided: 0,
    handoff: 0,
    llm: 0,
    skipped: 0
  }
  if (!getConfigBoolean(CFG_ENABLED, true)) return out
  const now = opts.now ?? Date.now()

  // 候选群：近 7 天活跃、非企微、有名字；「监控里排除的群」（采购/供应链/内部群）不参与自动回复
  let candidates = opts.groups ?? []
  if (candidates.length === 0) {
    const res = getSessions(wxid)
    if (!res.ok || !res.sessions) {
      return { ...out, ok: false, error: res.error || '会话列表读取失败' }
    }
    const windowStart = now - 6 * 24 * 3600_000
    candidates = res.sessions
      .filter(
        (s) =>
          s.isGroup &&
          !s.isWeCom &&
          s.lastTimestamp >= windowStart &&
          s.displayName.trim() !== '' &&
          !isGroupExcluded(wxid, s.username)
      )
      .sort((a, b) => b.lastTimestamp - a.lastTimestamp)
      .slice(0, MAX_GROUPS)
      .map((s) => ({ username: s.username, displayName: s.displayName }))
  }

  const switches = new Map(listGroupSwitches(wxid).map((s) => [s.groupUsername, s.enabled]))
  const enabledGroups = candidates.filter((g) => groupEnabled(g.username, switches))
  out.groups = enabledGroups.length
  if (enabledGroups.length === 0) return out

  const scripts = listScripts(wxid, { enabledOnly: true })
  const team = getTeamUsernamesCached(wxid)
  const shadowLlm = getConfigBoolean(CFG_SHADOW_LLM, true)
  let llmUsed = 0

  for (const g of enabledGroups) {
    try {
      const state = getDutyState(wxid, g.username)
      if (lastDecisionAt(state) && now - (state?.lastRunAt ?? 0) < COOLDOWN_MS) continue
      const windowStart = state?.lastMsgTime ?? now - INIT_LOOKBACK_MS
      // enrich=false 省一次开库；真正要判定的那几条再补昵称（下面一次 enrich）
      const read = readGroupMessages(wxid, g.username, windowStart, state?.lastSeq, {
        enrich: false
      })
      const fresh = read.msgs.filter((m) =>
        state?.lastSeq === undefined ? true : m.sortSeq > (state.lastSeq ?? -1)
      )
      if (fresh.length === 0) continue
      out.scanned += fresh.length
      const newest = fresh[fresh.length - 1]

      // 语音转写合流：上面按 enrich=false 读的（省一次开库），这里必须补一次——
      // 否则 mergeTrigger/nonText/LLM 兜底看到的全是「[语音]」，已转写的语音等于没转。
      decorateVoiceTranscripts(fresh, wxid)

      // 只有「最后一条是客户消息」才考虑介入：同事/我方已经答过就不插话（与议题引擎同一套退让逻辑）
      const inbound = fresh.filter((m) => !m.isSend && !isTeamMsg(m, team))
      const fromTeam = !newest.isSend && isTeamMsg(newest, team)
      const text = mergeTrigger(inbound)
      // 「看不懂」才转人工：有转写的语音算看得懂（否则一期把语音一律转人工，ASR 白花钱）
      const nonText = inbound.length > 0 && inbound.every((m) => !isMachineReadable(m))
      // 补昵称：只补要判定的这几条（话术模板里的 {{客户名}} 需要真实称呼）
      const named = enrichMessages(wxid, g.username, [...inbound.slice(-TRIGGER_MAX_MSGS), newest])
      const newestNamed = named[named.length - 1] ?? newest
      const customerName = newestNamed.senderNickname || newestNamed.senderUsername || ''
      const vars: Record<string, string> = {
        客户名: customerName,
        群名: g.displayName,
        日期: fmtStamp(now).slice(0, 10),
        时间: fmtStamp(now).slice(11) // 一律到秒(话术模板里 {时间} 也是秒级)
      }

      const decision = matchReply(
        { text, fromTeam: fromTeam || newest.isSend, nonText, vars },
        scripts
      )

      if (decision.action === 'skip') {
        out.skipped++
        // 客户发了图片/语音：数字员工读不懂，但这往往是真诉求 → 记一条「需人工看一眼」
        if (decision.skipReason === 'non-text') {
          const it = classifyIntentByRules(msgToText(newest))
          insertReply({
            accountWxid: wxid,
            groupUsername: g.username,
            groupName: g.displayName,
            triggerSeq: newest.sortSeq,
            triggerTime: newest.createTime,
            triggerText: msgToText(newest).slice(0, 500),
            decision: 'handoff',
            intent: it.intent,
            intentSource: it.source,
            intentConfidence: it.confidence,
            intentEvidence: it.evidence.join('、'),
            status: 'queued',
            reason: decision.reason
          })
          out.handoff++
        }
      } else if (decision.action === 'handoff') {
        insertReply({
          accountWxid: wxid,
          groupUsername: g.username,
          groupName: g.displayName,
          triggerSeq: newest.sortSeq,
          triggerTime: newest.createTime,
          triggerText: text.slice(0, 500),
          decision: 'handoff',
          scriptId: decision.script.id,
          intent: decision.script.intent,
          intentSource: 'script',
          intentConfidence: 1,
          intentEvidence: '命中话术',
          replyText: decision.replyText,
          riskLevel: decision.script.riskLevel,
          status: 'queued',
          reason: decision.reason
        })
        bumpScriptHit(decision.script.id)
        out.handoff++
      } else if (decision.action === 'confirm') {
        // 风险 B（价格/优惠/账期）：命中话术但**不经人工确认绝不发**。
        // 落 queued（值班页「需人工接手」），与 C 类同一个待办池，风险级别靠 riskLevel 区分。
        insertReply({
          accountWxid: wxid,
          groupUsername: g.username,
          groupName: g.displayName,
          triggerSeq: newest.sortSeq,
          triggerTime: newest.createTime,
          triggerText: text.slice(0, 500),
          decision: 'script',
          scriptId: decision.script.id,
          intent: decision.script.intent,
          intentSource: 'script',
          intentConfidence: 1,
          intentEvidence: '命中话术',
          replyText: decision.replyText,
          riskLevel: decision.script.riskLevel,
          status: 'queued',
          reason: decision.reason
        })
        bumpScriptHit(decision.script.id)
        out.handoff++
      } else if (decision.action === 'reply') {
        insertReply({
          accountWxid: wxid,
          groupUsername: g.username,
          groupName: g.displayName,
          triggerSeq: newest.sortSeq,
          triggerTime: newest.createTime,
          triggerText: text.slice(0, 500),
          decision: 'script',
          scriptId: decision.script.id,
          intent: decision.script.intent,
          intentSource: 'script',
          intentConfidence: 1,
          intentEvidence: '命中话术',
          replyText: decision.replyText,
          riskLevel: decision.script.riskLevel,
          status: 'shadow',
          reason: decision.reason
        })
        bumpScriptHit(decision.script.id)
        out.decided++
      } else {
        // 未命中话术：影子期按需调一次 LLM，让人看到「没有话术时它会怎么答」
        let draft = ''
        let reason = decision.reason
        if (shadowLlm && llmUsed < LLM_CAP_PER_PASS) {
          llmUsed++
          try {
            const gen = await generateSuggestions(
              wxid,
              g.username,
              g.displayName,
              read.msgs.slice(-20),
              {
                style: 'warm'
              }
            )
            draft = gen.candidates?.[0]?.text ?? ''
            if (!draft) reason = `${decision.reason}；LLM 未产出（${gen.error ?? '无候选'}）`
          } catch (e) {
            reason = `${decision.reason}；LLM 调用失败：${e instanceof Error ? e.message : String(e)}`
          }
        } else if (!shadowLlm) {
          reason = `${decision.reason}；影子期未开启 LLM 预演`
        }
        // 意图:未命中话术时也必须给结论(以前这里是空的,Base 的意图列因此大片空白)。
        // 先规则层(零成本);规则拿不准、且本轮 LLM 还有额度时才请模型复核一次。
        const it = await classifyIntent(text, {
          wxid,
          allowLlm: shadowLlm && llmUsed < LLM_CAP_PER_PASS
        })
        insertReply({
          accountWxid: wxid,
          groupUsername: g.username,
          groupName: g.displayName,
          triggerSeq: newest.sortSeq,
          triggerTime: newest.createTime,
          triggerText: text.slice(0, 500),
          decision: 'llm',
          intent: it.intent,
          intentSource: it.source,
          intentConfidence: it.confidence,
          intentEvidence: it.evidence.join('、'),
          replyText: draft,
          status: 'shadow',
          reason
        })
        out.llm++
      }

      // 水位推进到本轮最新消息（含我方消息：避免下轮把同一批再看一遍）
      saveDutyState(wxid, g.username, {
        lastSeq: newest.sortSeq,
        lastMsgTime: newest.createTime
      })
    } catch (e) {
      dutyLog.warn(
        `值班判定失败 ${g.displayName || g.username}: ${e instanceof Error ? e.message : String(e)}`
      )
    }
  }
  return out
}

/** 值班状态（供 UI 显示：开关数、最近一轮、影子记录数） */
export function dutyStatus(wxid: string): {
  enabled: boolean
  defaultEnabled: boolean
  defaultMode: GroupReplyMode
  overrides: number
  scripts: number
  shadowLlm: boolean
  /** 意图为空、可一键补全的历史记录数 */
  missingIntent: number
} {
  const switches = listGroupSwitches(wxid)
  return {
    enabled: getConfigBoolean(CFG_ENABLED, true),
    defaultEnabled: getConfigBoolean('agent.reply.defaultEnabled', true),
    defaultMode: defaultMode(),
    overrides: switches.length,
    scripts: listScripts(wxid, { enabledOnly: true }).length,
    shadowLlm: getConfigBoolean(CFG_SHADOW_LLM, true),
    /** 意图为空、可一键补全的历史记录数 */
    missingIntent: countRepliesMissingIntent()
  }
}

/** 供回放/预演使用：给定一批消息，输出每条的判定（不写库、不发消息） */
export function previewOnMessages(
  wxid: string,
  msgs: ChatMessage[],
  groupName = '',
  team = new Set<string>()
): Array<{
  time: number
  sender: string
  text: string
  action: string
  intent: string
  reply: string
  reason: string
}> {
  const scripts = listScripts(wxid, { enabledOnly: true })
  const out: Array<{
    time: number
    sender: string
    text: string
    action: string
    intent: string
    reply: string
    reason: string
  }> = []
  // 回放预演与线上判定必须是同一口径：先合流语音转写，再判「读不读得懂」
  decorateVoiceTranscripts(msgs, wxid)
  for (const m of msgs) {
    const fromTeam = m.isSend || isTeamMsg(m, team)
    const text = msgToText(m)
    const vars: Record<string, string> = {
      客户名: m.senderNickname || m.senderUsername || '',
      群名: groupName,
      日期: fmtStamp(m.createTime).slice(0, 10)
    }
    const d = matchReply({ text, fromTeam, nonText: !isMachineReadable(m), vars }, scripts)
    if (d.action === 'skip') continue
    const it = d.action === 'llm' ? classifyIntentByRules(text) : null
    out.push({
      time: m.createTime,
      sender: m.senderNickname || m.senderUsername || '',
      text: text.slice(0, 120),
      action: d.action,
      intent: it ? it.intent : d.action === 'llm' ? '' : d.script.intent,
      reply: d.action === 'llm' ? '' : d.replyText,
      reason: d.reason
    })
  }
  return out
}
