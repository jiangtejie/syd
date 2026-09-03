import * as wxService from '../wechat/wxService'
import { createAiProvider } from '../ai/provider'
import {
  clearIssues,
  listIssues,
  setIssueStatus,
  typeCounts,
  upsertIssue,
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
 * 群问题反馈分析器（看板）。
 * - 窗口：近 7 天（自然日）内活跃的群会话；
 * - 方式：OpenAI 兼容 LLM 分类提取；未配置/失败时按群回退本地规则（关键词 + 末尾未回复）；
 * - 落库策略：稳定 key upsert，重复分析不重置人工处理状态；
 * - 每次全量重扫该窗口，不删除历史行（归档等人工状态不因窗口滑动丢失）。
 */

const WINDOW_DAYS = 7
/** 单群扫描消息上限（窗口内消息超限时保留最新） */
const MAX_GROUP_MSGS = 800
/** 客户消息在此时间内获客服回复视为已跟进，规则模式不再重复建问题 */
const REPLY_WINDOW_MS = 30 * 60_000
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

/** 归一化发送者名：我方消息显示固定名，客户取昵称（群内昵称优先） */
function senderLabel(m: ChatMessage): string {
  if (m.isSend) return '我方客服'
  return m.senderNickname || m.senderUsername || '客户'
}

function isTextLike(m: ChatMessage): boolean {
  return m.localType === 1 || m.localType === 49
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

/** 本地规则提取：未回复关键词命中（同一条消息取优先级最高一类）+ 末尾未回复兜底 */
function ruleExtract(msgs: ChatMessage[]): NewIssue[] {
  const issues: NewIssue[] = []
  for (const m of msgs) {
    if (m.isSend || !isTextLike(m)) continue
    const text = msgToText(m)
    // 已获客服回复（REPLY_WINDOW_MS 内）视为已跟进，不再重复生成问题
    const replied = msgs.some(
      (x) => x.isSend && x.createTime > m.createTime && x.createTime - m.createTime <= REPLY_WINDOW_MS
    )
    if (replied) continue
    // 同一条消息只按 RULE_KEYWORDS 顺序取优先级最高的一个类型，避免一词多类型重复行
    const rule = RULE_KEYWORDS.find((r) => r.keywords.some((k) => text.includes(k)))
    if (!rule) continue
    issues.push({
      key: `${rule.type}|${m.createTime}|${m.localId}`,
      wxid: '',
      groupUsername: '',
      groupName: '',
      type: rule.type,
      title: `${senderLabel(m)}：${text.slice(0, 24)}`,
      summary: text.slice(0, 80),
      occurAt: m.createTime,
      method: 'rule',
      msgs: [msgToSummaryMsg(m, senderLabel(m))]
    })
  }
  // 末尾「客户提问未被回复」：窗内最后是客户文本、无后续我方消息、距今超 30 分钟；
  // 若该消息已命中关键词生成问题则不再重复追加
  const last = msgs[msgs.length - 1]
  if (
    last &&
    !last.isSend &&
    isTextLike(last) &&
    Date.now() - last.createTime > REPLY_WINDOW_MS &&
    !issues.some((it) => it.occurAt === last.createTime)
  ) {
    issues.push({
      key: `unreplied:${last.createTime}`,
      wxid: '',
      groupUsername: '',
      groupName: '',
      type: '咨询',
      title: `${senderLabel(last)}：${msgToText(last).slice(0, 24)}`,
      summary: '客户最后一条消息，30 分钟内未见客服回复',
      occurAt: last.createTime,
      method: 'rule',
      msgs: [msgToSummaryMsg(last, senderLabel(last))]
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
  msgs: ChatMessage[]
): Promise<NewIssue[]> {
  if (msgs.length === 0) return []
  const provider = createAiProvider()
  if (!provider) {
    return normalizeIssues(wxid, groupUsername, groupName, msgs, ruleExtract(msgs), 'rule')
  }
  // LLM 模式：文本相关行编号后送入（截最新，控制 token）
  const lines = msgs
    .filter((m) => isTextLike(m) || m.localType === 3)
    .map((m) => ({
      line: `${new Date(m.createTime).toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      })} ${senderLabel(m)}: ${msgToText(m)}`,
      msg: m,
      senderName: senderLabel(m)
    }))
    .slice(-LLM_LINES_CAP)
  if (lines.length === 0) return []
  const body = lines.map((it, i) => `[${i}] ${it.line}`).join('\n')

  const system = [
    '你是资深微信客服运营分析员。用户会给出一段客户服务群聊天记录，',
    '每行形如：[i] HH:mm 发送者: 内容，其中“我方客服”之外的都是客户/普通群友发言。',
    '请找出其中的客户问题/反馈/诉求（如客诉、售后、物流、价格、咨询、建议等），',
    '忽略客服内部说明、广告、表情图与寒暄。',
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
    return normalizeIssues(wxid, groupUsername, groupName, msgs, ruleExtract(msgs), 'rule')
  }
}

/** 单群分析（含写库）：读窗口消息 → LLM/规则提炼 → upsert，返回写入条数 */
async function analyzeOneGroup(
  wxid: string,
  groupUsername: string,
  groupName: string,
  windowStartMs: number
): Promise<number> {
  const msgs = readGroupMessages(wxid, groupUsername, windowStartMs)
  const issues = await analyzeGroup(wxid, groupUsername, groupName, msgs)
  let n = 0
  for (const issue of issues) {
    upsertIssue(issue)
    n++
  }
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
    for (const g of groups) {
      const n = await analyzeOneGroup(wxid, g.username, g.displayName, windowStart)
      upserted += n
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
