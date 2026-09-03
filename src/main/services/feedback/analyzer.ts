import * as wxService from '../wechat/wxService'
import { createAiProvider } from '../ai/provider'
import { getTeamUsernamesCached } from '../../db/repos/teamRepo'
import {
  clearIssues,
  listIssues,
  setIssueStatus,
  typeCounts,
  upsertIssue,
  listOpenUnrepliedByGroup,
  type NewIssue
} from '../../db/repos/issueRepo'
import { getConfig, setConfig } from '../../db/repos/config'
import type {
  ChatMessage,
  FeedbackAnalysisState,
  FeedbackIssue,
  FeedbackIssueMsg,
  FeedbackIssueStatus,
  FeedbackIssueType
} from '../../../shared/types'

/**
 * 群问题反馈分析器（看板 + 工作台）。
 * - 窗口：近 N 天（自然日）内活跃的群会话；
 * - 方式：OpenAI 兼容 LLM 分类提取；未配置/失败时按群回退本地规则（关键词 + 末尾未回复）；
 * - 「已跟进」判定为会话语义：客户消息之后、下一条客户消息之前出现我方/团队客服消息即视为已回复，
 *   不设固定时间窗（隔夜/超 30 分钟回复不再误报）；
 * - 团队客服成员（手动全局标识）的消息视同我方；
 * - unreplied 问题自动闭环：后续分析检测到锚点消息后有客服回复 → 自动 done（autoDone 标记）；
 * - 落库策略：稳定 key upsert，重复分析不重置人工处理状态。
 */

const WINDOW_DAYS = 7
/** 单群扫描消息上限（窗口内消息超限时保留最新） */
const MAX_GROUP_MSGS = 800
/** LLM 每群输入行数上限（超窗截断取最新，避免超长） */
const LLM_LINES_CAP = 220
/** 分析的群数上限（按活跃度取最新） */
const MAX_GROUPS = 30
/** 工作台单群分析节流：距上次尝试（成功或失败）短于该值时自动触发直接跳过（force 忽略） */
const GROUP_AUTO_REANALYZE_MS = 2 * 60_000
/** 单群分析尝试记录配置键（工作台「切群自动分析」防抖与失败信息透传） */
const groupStampKey = (wxid: string, group: string): string => `issue.groupAt:${wxid}:${group}`

export const ISSUE_TYPES: FeedbackIssueType[] = [
  '客诉',
  '售后',
  '物流',
  '价格',
  '咨询',
  '建议',
  '其他'
]

/** 本地兜底规则：命中即归类，文本仅在客户消息上匹配 */
const RULE_KEYWORDS: Array<{ type: FeedbackIssueType; keywords: string[] }> = [
  {
    type: '客诉',
    keywords: ['投诉', '差评', '垃圾', '太差', '翻车', '气死', '失望', '再也不买', '质量问题']
  },
  {
    type: '售后',
    keywords: ['退货', '退款', '换货', '维修', '质保', '保修', '三包', '售后']
  },
  {
    type: '物流',
    keywords: ['快递', '物流', '发货', '配送', '签收', '没到', '包裹', '运单', '迟迟不发', '截单']
  },
  {
    type: '价格',
    keywords: ['太贵', '价格', '优惠', '折扣', '差价', '涨价', '优惠券', '划算吗', '便宜点']
  },
  {
    type: '建议',
    keywords: ['建议', '希望', '能不能加', '期待', '优化', '要是能']
  },
  {
    type: '咨询',
    keywords: ['请问', '怎么', '如何', '可以吗', '什么时候', '多少钱', '在哪', '能用吗', '有没有', '支持吗']
  }
]

/** 单条消息转人类可读文本（供 LLM 上下文与规则匹配） */
function msgToText(m: ChatMessage): string {
  switch (m.localType) {
    case 1:
      return m.parsedContent || '[文本]'
    case 3:
      return '[图片]'
    case 34:
      return '[语音]'
    case 43:
      return '[视频]'
    case 47:
      return '[表情]'
    default:
      return m.parsedContent || '[消息]'
  }
}

function msgToSummaryMsg(m: ChatMessage, senderName: string): FeedbackIssueMsg {
  return {
    time: m.createTime,
    senderName,
    isSend: m.isSend,
    text: msgToText(m),
    imageMd5: m.imageMd5,
    localType: m.localType
  }
}

/** 归一化发送者名：我方消息固定名；团队客服同事标注；客户取昵称 */
function senderLabel(m: ChatMessage, team?: Set<string>): string {
  if (m.isSend) return '我方客服'
  const u = m.senderUsername
  if (team && u && team.has(u)) {
    const nick = m.senderNickname || u
    return nick === u ? '我方同事' : `我方同事（${nick}）`
  }
  return m.senderNickname || u || '客户'
}

/** LLM 上下文行消息过滤（真文本 + 带摘要的 appmsg + 图片） */
function isTextLike(m: ChatMessage): boolean {
  return m.localType === 1 || m.localType === 49
}

/** 规则模式只吃真文本（type 1）；49 型摘要（[链接]/[文件]/[聊天记录]/[转账]）会引入假关键词，不参与匹配 */
function isRuleText(m: ChatMessage): boolean {
  return m.localType === 1
}

/**
 * 会话语义「已跟进」判定：消息 idx 之后、下一条客户（非我方/非团队）消息之前，
 * 是否存在我方或团队客服消息。不再使用固定 30 分钟窗（隔夜/迟回复不误报）。
 */
function hasStaffReplyAfter(msgs: ChatMessage[], idx: number, team: Set<string>): boolean {
  for (let j = idx + 1; j < msgs.length; j++) {
    const x = msgs[j]
    const isStaff = x.isSend || (!!x.senderUsername && team.has(x.senderUsername))
    if (isStaff) return true
    // 系统消息等非客户对象不影响回合判定；遇到下一条客户消息仍未回复 → 视为未跟进
    if (!x.isSend && !x.senderUsername) continue
    if (!x.isSend) return false
  }
  return false
}

/** 收敛 LLM 输出类型到枚举 */
function normalizeType(t: string | undefined | null): FeedbackIssueType {
  const hit = ISSUE_TYPES.find((x) => x === t)
  if (hit) return hit
  const fuzzy = ISSUE_TYPES.find((x) => t?.includes(x))
  return fuzzy ?? '其他'
}

interface LlmIssue {
  type?: string
  title?: string
  summary?: string
  evidence?: number[]
}

function parseLlmJson(raw: string): LlmIssue[] {
  let text = raw.trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fence) text = fence[1].trim()
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  const data = JSON.parse(text.slice(start, end + 1)) as unknown
  if (!Array.isArray(data)) return []
  return data.filter((d): d is LlmIssue => !!d && typeof d === 'object')
}

/** 逐群读取窗口内消息（跨库自动分片分页，直到越过窗口起点或达上限） */
function readGroupMessages(wxid: string, groupUsername: string, windowStartMs: number): ChatMessage[] {
  const all: ChatMessage[] = []
  let cursor: Parameters<typeof wxService.getMessages>[3] = undefined
  for (;;) {
    const res = wxService.getMessages(wxid, groupUsername, 80, cursor)
    if (!res.ok || !res.messages || res.messages.length === 0) break
    const msgs = res.messages.filter((m) => m.createTime >= windowStartMs)
    all.unshift(...msgs) // 返回按时间升序，向后翻更旧页，因此插到头部
    const oldest = res.messages[0]
    // 已越过窗口起点 / 无更旧页 / 或已到限容：停止向后翻
    if (all.length >= MAX_GROUP_MSGS || !res.hasMore || !res.nextCursor || oldest.createTime < windowStartMs) {
      break
    }
    cursor = res.nextCursor
  }
  // 限容：超限时保留最新（时间升序 => 截尾部）
  return all.length > MAX_GROUP_MSGS ? all.slice(all.length - MAX_GROUP_MSGS) : all
}

/** 本地规则提取：客户真文本关键词命中（未获客服/团队跟进）+ 末尾未回复兜底（会话语义） */
function ruleExtract(msgs: ChatMessage[], team: Set<string>): NewIssue[] {
  const issues: NewIssue[] = []
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    const u = m.senderUsername
    if (m.isSend || (u && team.has(u)) || !isRuleText(m)) continue
    const text = msgToText(m)
    // 已跟进：其后至下一条客户消息前存在我方/团队客服回复
    if (hasStaffReplyAfter(msgs, i, team)) continue
    // 同一条消息只按 RULE_KEYWORDS 顺序取优先级最高的一个类型，避免一词多类型重复行
    const rule = RULE_KEYWORDS.find((r) => r.keywords.some((k) => text.includes(k)))
    if (!rule) continue
    issues.push({
      key: `${rule.type}|${m.createTime}|${m.localId}`,
      wxid: '',
      groupUsername: '',
      groupName: '',
      type: rule.type,
      title: `${senderLabel(m, team)}：${text.slice(0, 24)}`,
      summary: text.slice(0, 80),
      occurAt: m.createTime,
      method: 'rule',
      msgs: [msgToSummaryMsg(m, senderLabel(m, team))]
    })
  }
  // 末尾「客户留言无回复」：窗内最后一条客户真文本消息仍无任何我方/团队回复 → 待回复提示
  let tailIdx = -1
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    const u = m.senderUsername
    if (!m.isSend && !(u && team.has(u)) && isRuleText(m)) {
      tailIdx = i
      break
    }
  }
  const tail = tailIdx >= 0 ? msgs[tailIdx] : undefined
  if (
    tail &&
    !hasStaffReplyAfter(msgs, tailIdx, team) &&
    !issues.some((it) => it.occurAt === tail.createTime)
  ) {
    issues.push({
      key: `unreplied:${tail.createTime}`,
      wxid: '',
      groupUsername: '',
      groupName: '',
      type: '咨询',
      title: `${senderLabel(tail, team)}：${msgToText(tail).slice(0, 24)}`,
      summary: '客户留言后未见客服（或团队）回复',
      occurAt: tail.createTime,
      method: 'rule',
      msgs: [msgToSummaryMsg(tail, senderLabel(tail, team))]
    })
  }
  return issues
}

/** 归一化：规则结果补全账号/群；LLM 结果把行号映射回消息 */
function normalizeIssues(
  wxid: string,
  groupUsername: string,
  groupName: string,
  source: ChatMessage[] | Array<{ line: string; msg: ChatMessage; senderName: string }>,
  extracted: unknown[],
  method: 'llm' | 'rule'
): NewIssue[] {
  if (method === 'rule') {
    // key 保留消息级锚点（type|时间|localId），避免窗口滑动造成序号漂移而重复建行
    return (extracted as NewIssue[]).map((it) => ({
      ...it,
      key: `rule:${wxid}:${groupUsername}:${it.key}`,
      wxid,
      groupUsername,
      groupName
    }))
  }
  const lines = source as Array<{ line: string; msg: ChatMessage; senderName: string }>
  const issues: NewIssue[] = []
  const seenKeys = new Set<string>()
  for (const raw of extracted as LlmIssue[]) {
    // evidence 按行号升序归一：key 锚定最早一条证据，模型证据顺序变化也不会导致 key 漂移
    const evidenceIdx = (raw.evidence ?? [])
      .filter((i) => Number.isInteger(i) && i >= 0 && i < lines.length)
      .sort((a, b) => a - b)
    if (evidenceIdx.length === 0) continue
    const first = lines[evidenceIdx[0]].msg
    const key = `llm:${wxid}:${groupUsername}:${first.createTime}:${first.localId}`
    if (seenKeys.has(key)) continue // 同一问题被模型拆成多条时只保留首条
    seenKeys.add(key)
    issues.push({
      key,
      wxid,
      groupUsername,
      groupName,
      type: normalizeType(raw.type),
      title: (raw.title || '').slice(0, 30) || `群内反馈（${groupName}）`,
      summary: (raw.summary || '').slice(0, 90) || undefined,
      occurAt: first.createTime,
      method: 'llm',
      msgs: evidenceIdx.map((i) => {
        const it = lines[i]
        return msgToSummaryMsg(it.msg, it.senderName)
      })
    })
  }
  return issues
}

/** 单群分析：收集消息 -> LLM 或规则 -> issues（LLM 失败自动降级到该群规则） */
async function analyzeGroup(
  wxid: string,
  groupUsername: string,
  groupName: string,
  msgs: ChatMessage[],
  team: Set<string>
): Promise<NewIssue[]> {
  if (msgs.length === 0) return []
  const provider = createAiProvider()
  if (!provider) {
    return normalizeIssues(wxid, groupUsername, groupName, msgs, ruleExtract(msgs, team), 'rule')
  }
  // LLM 模式：文本相关行编号后送入（截最新，控制 token）
  const lines = msgs
    .filter((m) => isTextLike(m) || m.localType === 3)
    .map((m) => ({
      line: `${new Date(m.createTime).toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      })} ${senderLabel(m, team)}: ${msgToText(m)}`,
      msg: m,
      senderName: senderLabel(m, team)
    }))
    .slice(-LLM_LINES_CAP)
  if (lines.length === 0) return []
  const body = lines.map((it, i) => `[${i}] ${it.line}`).join('\n')

  const system = [
    '你是资深微信客服运营分析员。用户会给出一段客户服务群聊天记录，',
    '每行形如：[i] HH:mm 发送者: 内容，其中“我方客服”和“我方同事（xxx）”都是我们这边的人，',
    '其余的是客户/普通群友。',
    '请找出仍需运营关注的客户问题/反馈/诉求（如客诉、售后、物流、价格、咨询、建议等），',
    '忽略客服内部说明、广告、表情图与寒暄。',
    '已被我方明确解答、客户已致谢收尾或确认满意的诉求不要提取；拿不准宁可不提取。',
    '只输出严格 JSON 数组（不要 markdown、不要额外文字）：',
    '[{"type":"客诉|售后|物流|价格|咨询|建议|其他","title":"不超过24字的概括","summary":"不超过60字的现象说明","evidence":[至少1个最多4个行号]}]',
    'evidence 必须是记录中的行号 i；同问题的多句发言（含客服答复）都作为 evidence；宁可少而准，不要虚构。'
  ].join('')

  try {
    const raw = await provider.complete(system, body, { maxTokens: 1200 })
    const parsed = parseLlmJson(raw)
    return normalizeIssues(wxid, groupUsername, groupName, lines, parsed, 'llm')
  } catch {
    // LLM 失败：本群降级规则兜底，保证看板有数据
    return normalizeIssues(wxid, groupUsername, groupName, msgs, ruleExtract(msgs, team), 'rule')
  }
}

/** 自动闭环回溯上限：锚点早于该时限的问题不再回溯读取，直接视为超期 */
const AUTO_CLOSE_MAX_AGE_MS = 14 * 24 * 3600_000

/**
 * 自动闭环：对仍 open 的 unreplied 问题检查锚点消息后是否已出现客服/团队回复，
 * 有则自动 done（autoDone 标记，UI 区分「自动解决」）。
 * 锚点早于回溯上限（无法在读取范围内找到）时视为超期未跟进 → 自动搁置。
 * msgs 需覆盖锚点（analyzeOneGroup 会扩展读取窗口）。
 */
function autoCloseUnreplied(
  wxid: string,
  groupUsername: string,
  msgs: ChatMessage[],
  team: Set<string>
): number {
  const pend = listOpenUnrepliedByGroup(wxid, groupUsername)
  const now = Date.now()
  let closed = 0
  for (const p of pend) {
    // 锚消息 = 该时间点的客户消息（±1s 容差，防库时间精度差异）
    let anchorIdx = -1
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i]
      if (m.isSend) continue
      if (Math.abs(m.createTime - p.occurAt) <= 1000 && isRuleText(m)) {
        anchorIdx = i
        break
      }
    }
    if (anchorIdx < 0) {
      // 超出回溯范围仍未跟进：超期自动搁置（不再打扰，也不谎报"已回复"）
      if (now - p.occurAt > AUTO_CLOSE_MAX_AGE_MS) {
        setIssueStatus(p.id, 'stalled', true)
        closed++
      }
      continue
    }
    const staffLater = msgs
      .slice(anchorIdx + 1)
      .some((x) => x.isSend || (!!x.senderUsername && team.has(x.senderUsername)))
    if (staffLater) {
      setIssueStatus(p.id, 'done', true)
      closed++
    }
  }
  return closed
}

/** 单群分析（含写库）：读窗口消息 → LLM/规则提炼 → upsert + unreplied 自动闭环，返回写入条数 */
async function analyzeOneGroup(
  wxid: string,
  groupUsername: string,
  groupName: string,
  windowStartMs: number
): Promise<number> {
  const team = getTeamUsernamesCached(wxid)
  // 读取窗口向现存 open unreplied 的最早锚点扩展（自动闭环需要看到锚点后的回复；上限 14 天）
  let start = windowStartMs
  const pend = listOpenUnrepliedByGroup(wxid, groupUsername)
  const oldestAllowed = Date.now() - AUTO_CLOSE_MAX_AGE_MS
  for (const p of pend) {
    const cand = Math.max(p.occurAt - 1, oldestAllowed)
    if (cand < start) start = cand
  }
  const msgs = readGroupMessages(wxid, groupUsername, start)
  // 分析仅用请求窗口内的消息（扩展段只服务自动闭环）
  const windowMsgs = msgs.filter((m) => m.createTime >= windowStartMs)
  const issues = await analyzeGroup(wxid, groupUsername, groupName, windowMsgs, team)
  let n = 0
  for (const issue of issues) {
    upsertIssue(issue)
    n++
  }
  if (pend.length > 0) autoCloseUnreplied(wxid, groupUsername, msgs, team)
  return n
}

/** 读取某群最近一次分析尝试记录（成功或失败；失败携带 error 供 UI 透传） */
function readGroupStamp(
  wxid: string,
  groupUsername: string
): { at: number; method?: 'llm' | 'rule'; count?: number; error?: string } | null {
  const raw = getConfig(groupStampKey(wxid, groupUsername))
  if (!raw) return null
  try {
    const p = JSON.parse(raw) as {
      at?: number
      method?: string
      count?: number
      error?: string
    }
    if (typeof p.at !== 'number') return null
    return {
      at: p.at,
      method: p.method === 'llm' || p.method === 'rule' ? p.method : undefined,
      count: typeof p.count === 'number' ? p.count : undefined,
      error: p.error
    }
  } catch {
    return null
  }
}

const groupRunKeys = new Map<string, Promise<AnalyzeGroupResult>>()

export interface AnalyzeGroupResult {
  ok: boolean
  error?: string
  skipped?: boolean
  method?: 'llm' | 'rule'
  count?: number
  lastAt?: number
}

/**
 * 单群窗口分析（工作台「群问题」入口）。
 * - days 为自然日窗口（默认 2：今天 + 昨天，与看板口径一致）；
 * - 自动触发节流：距上次尝试（含失败）不足 GROUP_AUTO_REANALYZE_MS 直接 skipped（force 忽略）；
 * - 按群 in-flight 防重；失败也落尝试记录，避免反复切群触发失败重试轰炸。
 * - 与看板全量分析共用同一存储（稳定 key 以消息为锚点），两入口不产生重复行。
 */
export async function analyzeGroupIssues(
  wxid: string,
  groupUsername: string,
  groupName = '',
  opts: { days?: number; force?: boolean } = {}
): Promise<AnalyzeGroupResult> {
  if (!wxid || !groupUsername) return { ok: false, error: '缺少账号或群标识' }
  const days = Math.min(Math.max(Math.floor(opts.days ?? 2), 1), 30)
  const force = !!opts.force

  const stamp = readGroupStamp(wxid, groupUsername)
  if (!force && stamp && Date.now() - stamp.at < GROUP_AUTO_REANALYZE_MS) {
    return {
      ok: true,
      skipped: true,
      method: stamp.method,
      count: stamp.count,
      lastAt: stamp.at,
      error: stamp.error
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
    return { ok: true, skipped: true, method: last?.method, count: last?.count, lastAt: last?.at }
  }

  const stampNow = (at: number, extra: { method?: 'llm' | 'rule'; count?: number; error?: string }): void => {
    setConfig(
      groupStampKey(wxid, groupUsername),
      JSON.stringify({ at, method: extra.method, count: extra.count, error: extra.error ?? '' })
    )
  }

  const run = (async (): Promise<AnalyzeGroupResult> => {
    const startedAt = Date.now()
    try {
      const today = new Date(startedAt)
      today.setHours(0, 0, 0, 0)
      const windowStart = today.getTime() - (days - 1) * 24 * 3600_000
      const count = await analyzeOneGroup(wxid, groupUsername, groupName, windowStart)
      // 0 条时无法从结果推断方式：以是否配好 provider 判定（与全量分析口径一致）
      const provider = createAiProvider()
      const method: 'llm' | 'rule' = provider ? 'llm' : 'rule'
      stampNow(Date.now(), { method, count })
      return { ok: true, method, count, lastAt: Date.now() }
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

/** 分析并写库（带 in-flight 保护，按账号串行） */
const runningWxids = new Map<string, Promise<void>>()
/** 成功态（含 lastAt）配置键 */
const stateConfigKey = (wxid: string) => `issue.analyzed:${wxid}`
/** 失败标记配置键：失败不写 lastAt，仅标记，避免每次进入都重复自动全量扫描 */
const failConfigKey = (wxid: string) => `issue.analyzeFail:${wxid}`

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

    const groups = sessionsRes.sessions
      .filter(
        (s) => s.isGroup && !s.isWeCom && s.lastTimestamp >= windowStart && s.displayName.trim() !== ''
      )
      .sort((a, b) => b.lastTimestamp - a.lastTimestamp)
      .slice(0, MAX_GROUPS)

    let upserted = 0
    // 逐群走 analyzeGroupIssues（force）：统一按群锁、自动闭环，避免与工作台单群分析并发撞车
    for (const g of groups) {
      const r = await analyzeGroupIssues(wxid, g.username, g.displayName, {
        days: WINDOW_DAYS,
        force: true
      })
      if (r.ok && r.count) upserted += r.count
    }

    const payload = { at: Date.now(), method, count: upserted }
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

/** 读取最近一次分析记录（app_config 持久化；失败标记会随 state.error 返回） */
export function readState(wxid: string): FeedbackAnalysisState {
  const state: FeedbackAnalysisState = { running: runningWxids.has(wxid), wxid }
  const raw = getConfig(stateConfigKey(wxid))
  if (raw) {
    try {
      const p = JSON.parse(raw) as { at?: number; method?: string }
      if (p.method === 'llm' || p.method === 'rule') state.method = p.method
      if (typeof p.at === 'number') state.lastAt = p.at
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

export function updateIssueStatus(id: number, status: FeedbackIssueStatus): void {
  setIssueStatus(id, status)
}

/** 清空某账号的问题数据并复位分析/失败标记（下次分析从真实群消息重新提取） */
export function clearFeedbackIssues(wxid: string): void {
  clearIssues(wxid)
  setConfig(stateConfigKey(wxid), '')
  setConfig(failConfigKey(wxid), '')
}

export function issueTypeCounts(wxid: string) {
  return typeCounts(wxid)
}
