import * as wxService from '../wechat/wxService'
import { createAiProvider } from '../ai/provider'
import { getTeamUsernamesCached } from '../../db/repos/teamRepo'
import {
  clearIssues,
  clearOpenIssuesByGroup,
  findIssueByKey,
  findReopenCandidate,
  getIssueMsgs,
  listIssues,
  openIssueAnchorTimes,
  openIssueEvidenceTimes,
  openIssuesForGroup,
  openTopicIndex,
  recentRejectedSamples,
  restoreManualFields,
  setIssueStatus,
  snapshotOpenManualFields,
  upsertIssue,
  type ManualFieldSnapshot,
  type NewIssue,
  type OpenTopicRow
} from '../../db/repos/issueRepo'
import { getConfig, setConfig } from '../../db/repos/config'
import { getDb } from '../../db/database'
import { topicSame, type TopicFacts } from './issueSimilarity'
import { ruleExtract } from './ruleExtract'
import { analyzeLlmIssues, APX_MAX, chunkMainRows, normalizeIssues } from './llmExtract'
import { AUTO_CLOSE_MAX_AGE_MS, reconcileOpenIssues } from './reconcile'
import {
  fmtRow,
  INCR_TAIL_MS,
  isTextLike,
  mergeEvidence,
  msgIdentity,
  readGroupMessages,
  UNREPLIED_MERGE_MS,
  type LlmRow
} from './shared'
import type {
  ChatMessage,
  FeedbackAnalysisState,
  FeedbackIssue,
  FeedbackIssueStatus
} from '../../../shared/types'

/**
 * 群问题反馈分析器 —— **编排入口**（看板 + 工作台）。
 *
 * 模块分工（原单文件 1760 行按阶段拆开，便于单独演进/复用）：
 * - shared.ts      消息/文本层公共基础（消息→文本、发送人标签、回合内回复判定、证据合并、跨库读取窗口）
 * - ruleExtract.ts 规则提取（LLM 不可用/失败时的兜底：关键词聚类 + 末尾未回复）
 * - llmExtract.ts  LLM 提取（分批消费主区、按段排版、行号回映射、议题级归一化）
 * - reconcile.ts   规则型跟进/收尾判定（跟进中 / 待处理 / 静默收尾 / 超期搁置）
 * - duplicates.ts  存量重复议题合并（人工预览 + 高置信自动）
 * - 本文件         读取窗口与水位、单群/全量分析编排、进度与取消、对外状态与维护入口
 *
 * 关键口径：
 * - 窗口：增量按水位（时间 + 序号双线）；首次/重算按自然日窗口；
 * - 「已跟进」为会话语义：客户消息之后、下一条客户消息之前出现我方/团队消息即视为已回复，不设固定时间窗；
 * - 团队客服成员（手动全局标识）的消息视同我方；
 * - **规则管跟进、LLM 管闭环**：每轮分析对全部 open 问题做确定性判定，
 *   已回复 → 跟进中并记录回复时刻；未回复 → 待处理；客户静默超阈值 → 自动收尾(done/autoDone)；
 *   锚点超出回溯范围 → 超期自动搁置(stalled)。LLM 只负责语义闭环（客户确认/已解决）；
 * - 落库策略：稳定 key upsert（含 key 漂移兜底合并），重复分析不重置人工处理状态。
 */

const WINDOW_DAYS = 7

/** 分析的群数上限（按活跃度取最新） */
const MAX_GROUPS = 30

/** 工作台单群分析节流：距上次尝试（成功或失败）短于该值时自动触发直接跳过（force 忽略） */
const GROUP_AUTO_REANALYZE_MS = 2 * 60_000

/** 单群分析尝试记录配置键（工作台「切群自动分析」防抖与失败信息透传） */
const groupStampKey = (wxid: string, group: string): string => `issue.groupAt:${wxid}:${group}`

/** 读取某群最近一次分析尝试记录（成功或失败；失败携带 error 供 UI 透传） */
interface GroupStamp {
  at: number
  method?: 'llm' | 'rule'
  count?: number
  error?: string
  coverage?: IssueCoverage
}

function readGroupStamp(wxid: string, groupUsername: string): GroupStamp | null {
  const raw = getConfig(groupStampKey(wxid, groupUsername))
  if (!raw) return null
  try {
    const p = JSON.parse(raw) as {
      at?: number
      method?: string
      count?: number
      error?: string
      coverage?: IssueCoverage
    }
    if (typeof p.at !== 'number') return null
    return {
      at: p.at,
      method: p.method === 'llm' || p.method === 'rule' ? p.method : undefined,
      count: typeof p.count === 'number' ? p.count : undefined,
      error: p.error,
      coverage:
        p.coverage && typeof p.coverage.msgs === 'number'
          ? { msgs: p.coverage.msgs, truncated: !!p.coverage.truncated }
          : undefined
    }
  } catch {
    return null
  }
}

const groupRunKeys = new Map<string, Promise<AnalyzeGroupResult>>()

/** 单群分析覆盖度（面板据此提示「窗口是否被截断」） */
export interface IssueCoverage {
  /** 本次实际读取并参与分析的消息条数 */
  msgs: number
  /** 是否因单群条数上限（MAX_GROUP_MSGS）截断：窗口比实际覆盖范围更宽 */
  truncated: boolean
}

export interface AnalyzeGroupResult {
  ok: boolean
  error?: string
  skipped?: boolean
  method?: 'llm' | 'rule'
  /** 本次**新建**的问题数（既有问题的内容/状态更新不计入） */
  count?: number
  lastAt?: number
  /** 覆盖度（截断时 UI 明示「未覆盖整个窗口」） */
  coverage?: IssueCoverage
  /** 规则判定为跟进中的条数 */
  following?: number
  /** 静默收尾自动闭环的条数 */
  closed?: number
  /** 超期自动搁置的条数 */
  stalled?: number
}

// ── 增量水位（防重复解读/防漏读）──

const wmKey = (wxid: string, group: string): string => `issue.wm:${wxid}:${group}`

interface WmValue {
  at: number
  msgTime: number
  /** 已消费最新消息的 sortSeq（防「迟到写入」：时间未前进但序号前进的新消息不被 skip 吞掉） */
  sortSeq?: number
}

function readWm(wxid: string, groupUsername: string): WmValue | null {
  const raw = getConfig(wmKey(wxid, groupUsername))
  if (!raw) return null
  try {
    const p = JSON.parse(raw) as { at?: number; msgTime?: number; sortSeq?: number }
    if (typeof p.at === 'number' && typeof p.msgTime === 'number') {
      return {
        at: p.at,
        msgTime: p.msgTime,
        sortSeq: typeof p.sortSeq === 'number' ? p.sortSeq : undefined
      }
    }
  } catch {
    /* ignore */
  }
  return null
}

/** 保存/推进水位（msgTime 单调推进；sortSeq 取已消费最新一条） */
function saveWm(wxid: string, groupUsername: string, wm: WmValue): void {
  setConfig(
    wmKey(wxid, groupUsername),
    JSON.stringify({ at: wm.at, msgTime: wm.msgTime, sortSeq: wm.sortSeq })
  )
}

/** 清除某群分析状态(水位+节流标记):清空/重算后调用,保证下次进入走全量而不是被旧水位跳过 */
export function clearGroupRunState(wxid: string, groupUsername: string): void {
  setConfig(wmKey(wxid, groupUsername), '')
  setConfig(groupStampKey(wxid, groupUsername), '')
}

/**
 * 群消息库当前最新一条消息（peek 一页；读失败返回 null 表示不拦截）。
 * 只看时间/序号，跳过 enrich —— 这条路径每分钟每群都被巡检调用，
 * 之前每次都白开一次联系人库给 80 条消息查昵称。
 */
function peekLatestRow(
  wxid: string,
  groupUsername: string
): { createTime: number; sortSeq: number } | null {
  try {
    const res = wxService.getMessages(wxid, groupUsername, 80, undefined, true)
    if (!res.ok || !res.messages || res.messages.length === 0) return null
    const newest = res.messages[res.messages.length - 1]
    return { createTime: newest.createTime, sortSeq: newest.sortSeq }
  } catch {
    return null
  }
}

/** 全部读取消息 → LLM 文本行 */
function buildRows(msgs: ChatMessage[], team: Set<string>): LlmRow[] {
  return msgs.filter((m) => isTextLike(m) || m.localType === 3).map((m) => fmtRow(m, team))
}

/** LLM 不可用/失败时：规则全量（读取范围内，幂等） */
function fallbackRuleIssues(
  wxid: string,
  groupUsername: string,
  groupName: string,
  msgs: ChatMessage[],
  team: Set<string>
): NewIssue[] {
  return normalizeIssues(wxid, groupUsername, groupName, null, ruleExtract(msgs, team), 'rule')
}

/**
 * 单群分析（工作台「群问题」入口）—— 增量水位 SOP。
 * - 首次/force：全量（自然日窗口 days，并向前扩展到本群 open 议题最早证据与 unreplied 锚点，上限 14 天）；
 * - 增量（有水位且非 force）：先 peek 最新消息，水位后无新消息 → skipped（0 LLM，不重复解读）；
 *   有新消息 → 主区=水位后新行，附录=尾巴(3h/40 行)+open 议题证据行，上下文不截断；
 * - 分析成功推进水位（单调），失败不推进（下次补读，防漏）。
 * - 自动触发节流 2 分钟兜底；按群 in-flight 防重；与看板全量共用存储（key 消息锚定不重复建行）。
 */
export async function analyzeGroupIssues(
  wxid: string,
  groupUsername: string,
  groupName = '',
  opts: { days?: number; force?: boolean; reset?: boolean } = {}
): Promise<AnalyzeGroupResult> {
  if (!wxid || !groupUsername) return { ok: false, error: '缺少账号或群标识' }
  const days = Math.min(Math.max(Math.floor(opts.days ?? 2), 1), 30)
  const reset = !!opts.reset
  const force = !!opts.force || reset // 重算模式必然全量,避免「只清不扫」

  const stamp = readGroupStamp(wxid, groupUsername)
  if (!force && stamp && Date.now() - stamp.at < GROUP_AUTO_REANALYZE_MS) {
    return {
      ok: true,
      skipped: true,
      method: stamp.method,
      count: stamp.count,
      lastAt: stamp.at,
      error: stamp.error,
      coverage: stamp.coverage
    }
  }

  const runKey = `${wxid}|${groupUsername}`
  const inflight = groupRunKeys.get(runKey)
  if (inflight) {
    try {
      await inflight
    } catch {
      // 首发起方已返回错误
    }
    const last = readGroupStamp(wxid, groupUsername)
    return {
      ok: true,
      skipped: true,
      method: last?.method,
      count: last?.count,
      lastAt: last?.at,
      coverage: last?.coverage
    }
  }

  const stampNow = (
    at: number,
    extra: { method?: 'llm' | 'rule'; count?: number; error?: string; coverage?: IssueCoverage }
  ): void => {
    setConfig(
      groupStampKey(wxid, groupUsername),
      JSON.stringify({
        at,
        method: extra.method,
        count: extra.count,
        error: extra.error ?? '',
        coverage: extra.coverage
      })
    )
  }

  const run = (async (): Promise<AnalyzeGroupResult> => {
    const startedAt = Date.now()
    // 重算模式下先快照 open 行的人工字段（指派跟进人/疑似已确认），扫描结束后按 key 回填
    let manualSnapshot: ManualFieldSnapshot[] = []
    try {
      // 0) 重算/清空模式:清 open(重置语义)并复位分析状态(水位+节流),再重新提取(历史保留)
      if (reset) {
        manualSnapshot = snapshotOpenManualFields(wxid, groupUsername)
        clearOpenIssuesByGroup(wxid, groupUsername)
        clearGroupRunState(wxid, groupUsername)
      }
      // 1) 水位判定：增量模式且水位后无新消息 → 跳过（不重复解读）。
      //    时间未超水位但 sortSeq 已前进 = 迟到写入（补录/回拨的旧时间消息）：不 skip，
      //    主区按「序号前进 或 时间前进」判定，迟到行照样能被提取；水位按两条线各自单调推进。
      const wm = readWm(wxid, groupUsername)
      let incremental = false
      if (!force && wm) {
        const latest = peekLatestRow(wxid, groupUsername)
        if (latest !== null) {
          const timeNoNew = latest.createTime <= wm.msgTime
          const seqNoNew = wm.sortSeq === undefined || latest.sortSeq <= wm.sortSeq
          if (timeNoNew && seqNoNew) {
            return { ok: true, skipped: true, lastAt: wm.at }
          }
          incremental = true
        } else {
          incremental = true
        }
      }

      // 2) 读取窗口：主分析起点 + 向前扩展（open 议题证据行与其锚点，上限 14 天）
      const today = new Date(startedAt)
      today.setHours(0, 0, 0, 0)
      const base = today.getTime() - (days - 1) * 24 * 3600_000
      const oldestAllowed = Date.now() - AUTO_CLOSE_MAX_AGE_MS
      const openTimes = openIssueEvidenceTimes(wxid, groupUsername)
      // 每个 open 议题的锚点行时间：既用于扩展读取，也用于「附录必须先保住锚点行」
      const openAnchors = openIssueAnchorTimes(wxid, groupUsername)
      let extendMs: number | null = null
      const consider = (t: number): void => {
        const cand = Math.max(t - 1, oldestAllowed)
        if (extendMs === null || cand < extendMs) extendMs = cand
      }
      for (const t of openTimes) consider(t)
      for (const t of openAnchors) consider(t)

      const focusStart = incremental ? wm!.msgTime : base
      // 增量时按序号线判定主区（迟到写入的旧时间行也算主区），非增量时按时间窗判定
      const focusSeq = incremental ? wm!.sortSeq : undefined
      let readStart = incremental ? Math.max(wm!.msgTime - INCR_TAIL_MS, oldestAllowed) : base
      if (extendMs !== null && extendMs < readStart) readStart = extendMs
      readStart = Math.max(readStart, oldestAllowed)

      const read = readGroupMessages(wxid, groupUsername, readStart, focusSeq)
      const msgs = read.msgs
      const coverage: IssueCoverage = { msgs: msgs.length, truncated: read.truncated }
      const team = getTeamUsernamesCached(wxid)
      const provider = createAiProvider()
      if (msgs.length === 0) {
        const method: 'llm' | 'rule' = provider ? 'llm' : 'rule'
        stampNow(Date.now(), { method, count: 0 })
        return { ok: true, method, count: 0, lastAt: Date.now() }
      }
      // 3) 主区/附录划分。附录行有名额上限，必须优先保住「每个 open 议题的锚点行」：
      //    锚点行一旦被挤出上下文，模型就只能为同一议题另起一条(新 key) → 重复待办 + 旧行永不闭环。
      const allRows = buildRows(msgs, team)
      const mainRows: LlmRow[] = []
      const preRows = allRows.filter((r) => r.msg.createTime < focusStart)
      const tailSet = new Set(preRows.slice(-INCR_TAIL_ROWS).map((r) => r.msg.createTime))
      const anchorSet = new Set(openAnchors)
      // 主区 = 序号前进的行（含迟到写入）或时间前进的行；其余进附录候选
      const isMainRow = (r: LlmRow): boolean =>
        focusSeq !== undefined
          ? r.msg.sortSeq > focusSeq || r.msg.createTime >= focusStart
          : r.msg.createTime >= focusStart
      for (const r of allRows) if (isMainRow(r)) mainRows.push(r)
      const apxCandidates = allRows.filter(
        (r) =>
          !isMainRow(r) &&
          (anchorSet.has(r.msg.createTime) ||
            openTimes.has(r.msg.createTime) ||
            tailSet.has(r.msg.createTime))
      )
      const apxRows: LlmRow[] = []
      const apxSeen = new Set<string>()
      const pushApx = (r: LlmRow): void => {
        const id = msgIdentity(r.msg)
        if (apxSeen.has(id)) return
        apxSeen.add(id)
        apxRows.push(r)
      }
      // ① 锚点行优先（超出名额时保最新的锚点：老议题多已超期搁置）
      const anchorRows = apxCandidates.filter((r) => anchorSet.has(r.msg.createTime))
      const keptAnchors =
        anchorRows.length > APX_MAX ? anchorRows.slice(anchorRows.length - APX_MAX) : anchorRows
      keptAnchors.forEach(pushApx)
      // ② 剩余名额给最近的上下文行
      const room = Math.max(0, APX_MAX - apxRows.length)
      if (room > 0) {
        const rest = apxCandidates.filter((r) => !anchorSet.has(r.msg.createTime))
        rest.slice(-room).forEach(pushApx)
      }
      apxRows.sort((a, b) => a.msg.createTime - b.msg.createTime || a.msg.localId - b.msg.localId)
      // 兜底：主区为空（极端窗位）→ 全部当主区处理，避免漏读
      if (mainRows.length === 0 && allRows.length > 0) {
        mainRows.push(...allRows)
        apxRows.length = 0
      }

      // 4) 提取：LLM 按段分批消费（每批落库后再取下一批 openHints；某批失败则该批起
      //    剩余消息用规则补读，避免高活跃群截断丢段，也避免整窗漏提）
      let method: 'llm' | 'rule' = 'rule'
      let n = 0
      /** 客户 username 归并：证据行里非我方、非团队客服的发送人（客户改昵称也能认出同一个人） */
      const deriveCustomerUsernames = (issue: NewIssue): string[] =>
        Array.from(
          new Set(
            issue.msgs
              .map((m) => (m.isSend || m.senderIsTeam ? '' : (m.senderUsername ?? '')))
              .filter((u) => !!u)
          )
        ).slice(0, 6)
      /** 客户身份（昵称 + username）：复发识别与同议题合并都用它匹配 */
      const deriveIdentity = (issue: NewIssue): { customers?: string[]; usernames: string[] } => ({
        customers: deriveCustomers(issue),
        usernames: deriveCustomerUsernames(issue)
      })
      // 议题同一性判据：一次查询取本群现存 open 议题事实，随本轮落库**增量维护**
      // （这样同一轮里后一批/后一个议题也能认出前面刚建的同一议题，防分批重复）
      const topicIndex: OpenTopicRow[] = openTopicIndex(wxid, groupUsername)
      const rowFacts = (r: OpenTopicRow): TopicFacts => ({
        title: r.title,
        type: r.type,
        customers: r.customers,
        usernames: r.usernames,
        evidenceTimes: r.evidenceTimes,
        occurAt: r.occurAt
      })
      const issueFacts = (
        it: NewIssue,
        identity: { customers?: string[]; usernames: string[] }
      ): TopicFacts => ({
        title: it.title,
        type: it.type,
        customers: identity.customers,
        usernames: identity.usernames,
        evidenceTimes: Array.from(new Set(it.msgs.map((m) => m.time))),
        occurAt: it.occurAt
      })
      /** 本轮新建的行 id：对它们禁用「时间邻近」判据（模型刚在同一批输入里主动拆成两条，不该按时间并回去） */
      const createdThisRun = new Set<number>()
      /** 在现存/本轮已建的 open 议题里找同一条（标题 / 证据重叠 / 同客户+同类型+时间邻近 三组判据） */
      const matchExisting = (
        it: NewIssue,
        identity: { customers?: string[]; usernames: string[] }
      ): OpenTopicRow | undefined => {
        const facts = issueFacts(it, identity)
        for (const row of topicIndex) {
          const unreplied = it.key.includes(':unreplied:') || row.key.includes(':unreplied:')
          // 未回复留言是「同一件没人处理的事」，时间窗放宽到 72h；
          // 本轮刚建的行走 0（跳过时间判据），只认标题/证据这类更强信号
          const gap = createdThisRun.has(row.id) ? 0 : unreplied ? UNREPLIED_MERGE_MS : undefined
          if (topicSame(facts, rowFacts(row), { maxTimeGapMs: gap }).same) return row
        }
        return undefined
      }
      /** 客户身份回退：从证据行取非我方发送人昵称（LLM/规则均可能缺 customers） */
      const deriveCustomers = (issue: NewIssue): string[] | undefined => {
        if (issue.customers && issue.customers.length > 0) return issue.customers
        const names = Array.from(
          new Set(
            issue.msgs
              .map((m) => m.senderName)
              .filter((x) => !!x && !x.startsWith('我方'))
              .map((x) => x.trim())
              .filter(Boolean)
          )
        ).slice(0, 4)
        return names.length > 0 ? names : undefined
      }
      // 整批包一个事务:每个 issue 内部是「1 条 update + 1 条 delete + k 条 insert」,
      // 逐条自动提交在 WAL 下慢一个数量级,中途异常还会留下删了一半的中间态
      const applyExtracted = (list: NewIssue[]): void => {
        const tx = getDb().transaction(() => {
          for (const issue of list) {
            if (issue.resolved) {
              let existing = findIssueByKey(issue.key)
              if (!existing) {
                // key 漂移兜底：模型判定已闭环，但锚点行变了 → 按同一性判据找到真正的旧行并闭环
                const target = matchExisting(issue, deriveIdentity(issue))
                if (target) existing = findIssueByKey(target.key)
              }
              if (existing && existing.status === 'open') {
                setIssueStatus(existing.id, 'done', true)
              }
              continue
            }
            const customers = deriveCustomers(issue)
            issue.customers = customers
            const identity = deriveIdentity(issue)
            // 同 key 既有行；找不到再按同一性判据复用其 key（防锚点漂移重复建行）
            let prev = findIssueByKey(issue.key)
            if (!prev) {
              const target = matchExisting(issue, identity)
              if (target) {
                issue.key = target.key
                prev = findIssueByKey(target.key)
              }
            }
            if (prev) {
              // 既有行：保留最早发生时间与既有证据（LLM key 依赖最早证据行，证据被覆盖会导致下轮再漂移）
              issue.occurAt = Math.min(issue.occurAt, prev.occurAt)
              if (prev.status === 'open') {
                issue.msgs = mergeEvidence(getIssueMsgs(prev.id), issue.msgs)
              }
            } else {
              // 复发识别：仅对全新行判定（同 key 已存在 = 同一轮/历史行，不重复计数）
              const cand = findReopenCandidate(
                wxid,
                groupUsername,
                issue.type,
                identity,
                issue.occurAt
              )
              if (cand) {
                issue.reopenCount = cand.reopenCount + 1
                issue.reopenedFrom = cand.id
              }
            }
            // 计数口径 = 真正新建的行（既有行的内容/状态更新不算「新问题」，
            // 否则提示音、桌面通知与飞书「新问题」推送会把老问题的更新当新问题播报）
            const res = upsertIssue(issue)
            if (res.created) {
              n++
              createdThisRun.add(res.id)
            }
            // 增量维护判据索引（含证据/标题的最新值），供本轮后续议题与批次比对
            const nextRow: OpenTopicRow = {
              id: res.id,
              key: issue.key,
              type: issue.type,
              method: issue.method,
              title: issue.title,
              occurAt: issue.occurAt,
              customers: issue.customers,
              usernames: deriveCustomerUsernames(issue),
              evidenceTimes: Array.from(new Set(issue.msgs.map((m) => m.time)))
            }
            const at = topicIndex.findIndex((t) => t.key === issue.key)
            if (at >= 0) topicIndex[at] = nextRow
            else topicIndex.push(nextRow)
          }
        })
        tx()
      }
      const llmBadExamples = (): string[] => recentRejectedSamples(wxid, groupUsername, 3)
      if (provider && mainRows.length > 0) {
        method = 'llm'
        // 最后成功消费的主区行（消息对象锚点），失败补读时据此切“剩余消息”
        let consumed: ChatMessage | null = null
        const chunks = chunkMainRows(mainRows)
        for (let ci = 0; ci < chunks.length; ci++) {
          const chunk = chunks[ci]
          try {
            const openNow = openIssuesForGroup(wxid, groupUsername, 6)
            const openHints = openNow.map(
              (i) =>
                `[${i.type}${i.severity && i.severity !== '一般' ? `·${i.severity}` : ''}] ${i.title}${
                  i.followUp ? '（跟进中）' : ''
                } · 首现 ${new Date(i.occurAt).toLocaleString('zh-CN', { hour12: false })}`
            )
            const out = await analyzeLlmIssues(
              wxid,
              groupUsername,
              groupName,
              chunk,
              apxRows,
              openHints,
              llmBadExamples(),
              openNow.map((i) => i.key)
            )
            applyExtracted(out)
            consumed = chunk[chunk.length - 1].msg
          } catch {
            // 已成功批保留；成功边界之后的消息用规则补读（避免与 LLM 行重复建）
            const rest =
              consumed !== null ? msgs.slice(msgs.findIndex((m) => m === consumed) + 1) : msgs
            if (rest.length > 0) {
              applyExtracted(fallbackRuleIssues(wxid, groupUsername, groupName, rest, team))
            }
            break
          }
        }
      } else if (msgs.length > 0) {
        applyExtracted(fallbackRuleIssues(wxid, groupUsername, groupName, msgs, team))
      }

      // 4b) 重算模式：回填人工字段（指派跟进人/疑似确认），重算不该悄悄清掉人的操作
      if (manualSnapshot.length > 0) restoreManualFields(manualSnapshot)

      // 5) 规则跟进/收尾判定（全部 open 问题：跟进中 → 静默收尾 → 超期搁置）
      const rec = reconcileOpenIssues(wxid, groupUsername, msgs, team)

      // 6) 成功推进水位（时间与序号各自单调推进；失败不推进，下次自动补读）
      const prevWm = readWm(wxid, groupUsername)
      const maxCreateTime = msgs.reduce((m, x) => (x.createTime > m ? x.createTime : m), 0)
      const newestRow = msgs[msgs.length - 1]
      const nextMsgTime = Math.max(maxCreateTime, prevWm?.msgTime ?? 0)
      const nextSeq = Math.max(newestRow.sortSeq, prevWm?.sortSeq ?? -1)
      if (!prevWm || nextMsgTime > prevWm.msgTime || nextSeq > (prevWm.sortSeq ?? -1)) {
        saveWm(wxid, groupUsername, { at: Date.now(), msgTime: nextMsgTime, sortSeq: nextSeq })
      }
      stampNow(Date.now(), { method, count: n, coverage })
      return {
        ok: true,
        method,
        count: n,
        lastAt: Date.now(),
        coverage,
        following: rec.following,
        closed: rec.closed,
        stalled: rec.stalled
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      stampNow(Date.now(), { error })
      return { ok: false, error }
    }
  })()

  groupRunKeys.set(runKey, run)
  try {
    return await run
  } finally {
    groupRunKeys.delete(runKey)
  }
}

// ── 全量重析的进度与取消（30 个群串行跑可能几分钟，没进度/不能停体验很差）──

export interface IssueProgress {
  wxid: string
  phase: 'group' | 'done' | 'cancelled'
  done: number
  total: number
  /** 当前处理的群名（phase=group 时有值） */
  current?: string
}

type IssueProgressSink = (p: IssueProgress) => void
let progressSink: IssueProgressSink | null = null

/** 注入进度出口（IPC 层注册 → 渲染端 cs:issue:progress）；传 null 取消注册 */
export function setIssueProgressSink(fn: IssueProgressSink | null): void {
  progressSink = fn
}

/** 已请求取消的账号（按群边界停下：当前群跑完即中止，已产出的结果保留） */
const cancelRequested = new Set<string>()

/** 请求取消该账号正在跑的全量重析 */
export function cancelIssuesAnalysis(wxid: string): void {
  if (wxid) cancelRequested.add(wxid)
}

/** 分析并写库（带 in-flight 保护，按账号串行） */
const runningWxids = new Map<string, Promise<void>>()

/** 成功态（含 lastAt）配置键 */
const stateConfigKey = (wxid: string): string => `issue.analyzed:${wxid}`

/** 失败标记配置键：失败不写 lastAt，仅标记，避免每次进入都重复自动全量扫描 */
const failConfigKey = (wxid: string): string => `issue.analyzeFail:${wxid}`

export async function analyzeIssues(
  wxid: string
): Promise<{ ok: boolean; error?: string; state?: FeedbackAnalysisState }> {
  const inFlight = runningWxids.get(wxid)
  if (inFlight) {
    await inFlight
    return { ok: true, state: readState(wxid) }
  }
  let resolveRun!: () => void
  const runPromise = new Promise<void>((r) => (resolveRun = r))
  runningWxids.set(wxid, runPromise)
  try {
    const provider = createAiProvider()
    const method: 'llm' | 'rule' = provider ? 'llm' : 'rule'

    const sessionsRes = wxService.getSessions(wxid)
    if (!sessionsRes.ok || !sessionsRes.sessions) {
      return { ok: false, error: sessionsRes.error || '读取会话失败' }
    }
    const now = Date.now()
    const today = new Date(now)
    today.setHours(0, 0, 0, 0)
    const windowStart = today.getTime() - (WINDOW_DAYS - 1) * 24 * 3600_000

    const candidates = sessionsRes.sessions
      .filter(
        (s) =>
          s.isGroup && !s.isWeCom && s.lastTimestamp >= windowStart && s.displayName.trim() !== ''
      )
      .sort((a, b) => b.lastTimestamp - a.lastTimestamp)
    const groups = candidates.slice(0, MAX_GROUPS)
    // 覆盖度透明：活跃群超过上限时只扫前 N 个，UI 明示，不再静默截断
    const capped = candidates.length > groups.length

    let upserted = 0
    let scanned = 0
    let cancelled = false
    cancelRequested.delete(wxid)
    progressSink?.({ wxid, phase: 'group', done: 0, total: groups.length })
    // 逐群走 analyzeGroupIssues（force）：统一按群锁、自动闭环，避免与工作台单群分析并发撞车
    for (const g of groups) {
      if (cancelRequested.has(wxid)) {
        cancelled = true
        break
      }
      const r = await analyzeGroupIssues(wxid, g.username, g.displayName, {
        days: WINDOW_DAYS,
        force: true
      })
      if (r.ok && r.count) upserted += r.count
      scanned += 1
      progressSink?.({
        wxid,
        phase: 'group',
        done: scanned,
        total: groups.length,
        current: g.displayName
      })
    }
    cancelRequested.delete(wxid)
    progressSink?.({
      wxid,
      phase: cancelled ? 'cancelled' : 'done',
      done: scanned,
      total: groups.length
    })

    const payload = {
      at: Date.now(),
      method,
      count: upserted,
      groups: scanned,
      groupsTotal: groups.length,
      capped,
      cancelled
    }
    setConfig(stateConfigKey(wxid), JSON.stringify(payload))
    setConfig(failConfigKey(wxid), '') // 成功后清除历史失败标记
    const state: FeedbackAnalysisState = {
      running: false,
      wxid,
      method,
      lastAt: payload.at,
      issueCount: listIssues(wxid).length
    }
    return { ok: true, state }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    setConfig(failConfigKey(wxid), JSON.stringify({ at: Date.now(), error }))
    const state = readState(wxid)
    return { ok: false, error, state: { ...state, running: false } }
  } finally {
    runningWxids.delete(wxid)
    resolveRun()
  }
}

/** 该群是否已有增量水位（后台调度只对已建水位的群做增量；未扫过的群由「打开群/手动」首次全量，避免冷启动风暴） */
export function hasGroupWatermark(wxid: string, groupUsername: string): boolean {
  return readWm(wxid, groupUsername) !== null
}

/** 读取最近一次分析记录（app_config 持久化；失败标记会随 state.error 返回） */
export function readState(wxid: string): FeedbackAnalysisState {
  const state: FeedbackAnalysisState = { running: runningWxids.has(wxid), wxid }
  const raw = getConfig(stateConfigKey(wxid))
  if (raw) {
    try {
      const p = JSON.parse(raw) as {
        at?: number
        method?: string
        groups?: number
        groupsTotal?: number
        capped?: boolean
        cancelled?: boolean
      }
      if (p.method === 'llm' || p.method === 'rule') state.method = p.method
      if (typeof p.at === 'number') state.lastAt = p.at
      if (typeof p.groups === 'number') state.groups = p.groups
      if (typeof p.groupsTotal === 'number') state.groupsTotal = p.groupsTotal
      if (p.capped) state.groupsCapped = true
      if (p.cancelled) state.cancelled = true
      state.issueCount = listIssues(wxid).length
    } catch {
      // 配置损坏则仅返回运行态
    }
  }
  const failRaw = getConfig(failConfigKey(wxid))
  if (failRaw) {
    try {
      const f = JSON.parse(failRaw) as { error?: string }
      if (f.error) state.error = f.error.slice(0, 200)
    } catch {
      state.error = '上次分析失败'
    }
  }
  return state
}

export function listFeedbackIssues(wxid: string): FeedbackIssue[] {
  return listIssues(wxid)
}

// ── 存量去重：合并历史锚点漂移留下的重复议题 ──

export function updateIssueStatus(id: number, status: FeedbackIssueStatus): void {
  setIssueStatus(id, status)
}

/** 清空某账号的问题数据并复位分析/失败标记与各群水位/节流（下次自动分析从真实群消息全量重新提取） */
export function clearFeedbackIssues(wxid: string): void {
  // 先收集该账号出现过的群,逐一清除增量水位与节流标记,避免清空后被旧水位跳过
  const groups = new Set(listIssues(wxid).map((i) => i.groupUsername))
  clearIssues(wxid)
  setConfig(stateConfigKey(wxid), '')
  setConfig(failConfigKey(wxid), '')
  for (const g of groups) clearGroupRunState(wxid, g)
}

/** 增量模式的尾巴保留行数（上次分析点前未成议题的对话，作为新进展的上下文） */
const INCR_TAIL_ROWS = 40

// ── 对外保持原有入口（拆模块后调用方无需改动）──
export { ISSUE_TYPES } from './shared'
export { mergeDuplicateIssues } from './duplicates'
export type { DuplicateMergePlanItem, DuplicateMergeResult } from './duplicates'
export { reconcileGroupFollowups } from './reconcile'
export type { ReconcileResult } from './reconcile'
