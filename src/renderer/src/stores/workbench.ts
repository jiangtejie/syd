import { create } from 'zustand'
import type {
  AiAgent,
  ChatMessage,
  FeedbackIssue,
  FeedbackIssueDetail,
  FeedbackIssueStatus,
  MessageCursor,
  ReplyCandidate,
  SessionSummary
} from '../../../shared/types'
import { toast } from './toast'

/**
 * 客服工作台状态（T6/T7）。
 * 数据源：真实 IPC（微信库）。未连接 / 无数据时展示空占位（不使用 mock 数据）。
 * AI 建议：渲染端持有当前消息上下文，交给主进程生成（T7）。
 */

/** 数据来源：wx=已连接真实微信库；empty=未连接/无数据（空占位） */
export type DataSource = 'wx' | 'empty'

/** 工作台页面（应用外壳导航） */
export type WorkbenchPage =
  'workbench' | 'monitor' | 'chat' | 'customers' | 'dashboard' | 'settings' | 'export' | 'growth'

interface WorkbenchState {
  /** 当前页面 */
  page: WorkbenchPage
  /** 当前微信账号 wxid */
  wxid: string | null
  /** 数据来源（mock=示例数据 / wx=真实微信库） */
  source: DataSource
  sessions: SessionSummary[]
  activeSessionId: string | null
  messages: ChatMessage[]
  loading: boolean
  /** 是否有更早的历史消息可加载（keyset 分页） */
  messagesHasMore: boolean
  /** 加载更早消息的游标（null=没有更多） */
  nextCursor: MessageCursor | null
  /** 是否正在加载更早消息 */
  loadingOlder: boolean
  /** 解密层未实现时的提示 */
  fallbackReason: string | null

  /** AI 建议（T7，候选均来自 LLM 通道） */
  suggestions: ReplyCandidate[]
  suggestLoading: boolean
  suggestError: string | null
  /** 已选中的建议文本（T8 发送入口用） */
  chosenText: string | null

  /** 智能体（统一人设）：全端共用一条；agents/defaultAgentId 仅用于展示当前生效人设 */
  agents: AiAgent[]
  /** 全局当前生效人设 id（由设置页维护；各 AI 通道统一取用，不再提供切换） */
  defaultAgentId: string | null

  /** 建议自动生成去重键(最新对方消息 session::msgId),同一消息不重复触发 */
  suggestAutoKey: string | null
  /** 自动生成节流时间戳(仅新消息推送路径 ≥8s) */
  suggestAutoAt: number
  /** 依据「最新一条为对方消息」自动生成建议(quiet=推送路径带节流) */
  considerSuggestAuto: (quiet?: boolean) => void

  /** 群问题（右栏「群问题」视图，仅群会话；数据来自 issue_feedback，与看板同源同状态） */
  groupIssues: FeedbackIssue[]
  /** 上次单群分析覆盖度（条数上限截断时面板明示「未覆盖整个窗口」） */
  groupCoverage: { msgs: number; truncated: boolean } | null
  /** 本群是否已排除监控（采购/供应链/内部群不该产出客户问题） */
  groupExcluded: boolean
  groupIssueLoading: boolean
  groupAnalyzing: boolean
  groupIssueError: string | null
  /** 最近一次分析/尝试时间戳（头显展示用） */
  groupAnalyzedAt: number | null
  /** 分析窗口（自然日，默认 2：今天+昨天；看板为 7） */
  groupDays: number
  /** 展开中的问题详情（证据消息时间线） */
  groupActiveDetail: FeedbackIssueDetail | null
  groupDetailLoading: boolean
  /** 各群 open 问题计数（会话列表徽标） */
  groupBadges: Record<string, number>
  /** 定位提示：滚动消息区到指定时间附近（{sessionId, targetMs, nonce}） */
  scrollHint: { sessionId: string; targetMs: number; nonce: number } | null

  /** 发送（T8） */
  sending: boolean
  sendResult: { ok: boolean; error?: string; status?: string; verified?: boolean } | null

  init: (wxid: string) => Promise<void>
  selectSession: (sessionId: string) => Promise<void>
  refreshSessions: () => Promise<void>
  loadOlder: () => Promise<void>
  /** 增量刷新当前会话消息(水位=最后一条真实消息 sortSeq;用于 dbChanged 推送后自动补新) */
  refreshCurrentMessages: () => Promise<void>
  loadAgents: () => Promise<void>
  generateSuggestions: () => Promise<void>
  adoptSuggestion: (text: string) => void
  sendText: (text: string, source?: string) => Promise<void>
  /** 发送单条图片/文件(与文本同一串行队列) */
  sendFile: (path: string, kind: 'image' | 'file') => Promise<void>
  /** 群问题视图：读取该群问题列表并自动触发窗口分析（主进程侧节流） */
  loadGroupIssues: (sessionId: string) => Promise<void>
  /** 手动强制重新分析当前群;reset=true 先清空本群待处理/跟进中记录再重扫(历史已解决/归档保留) */
  analyzeGroupNow: (opts?: { reset?: boolean }) => Promise<void>
  /** 切换分析窗口天数；当前为群时立即以新窗口强制重析 */
  setGroupDays: (days: number) => void
  /** 仅重新拉取当前群问题列表（分析后/状态变更后刷新） */
  refreshGroupIssues: () => Promise<void>
  /** 展开/关闭问题详情（证据时间线） */
  openGroupIssue: (id: number | null) => Promise<void>
  /** 状态流转（open/done/stalled/archived），本地即时生效并回写主进程 */
  setGroupIssueStatus: (id: number, status: FeedbackIssueStatus) => Promise<void>
  /** 疑似确认：核实为真问题 → 移出疑似桶并计入正式待办 */
  confirmGroupIssue: (id: number) => Promise<void>
  /** 指派/更换/取消本群问题的跟进人（团队成员 username；null = 取消指派） */
  assignGroupIssue: (id: number, username: string | null) => Promise<void>
  /** 群级参与开关：排除时可选顺带归档现有待处理记录 */
  setGroupScope: (excluded: boolean, opts?: { archiveOpen?: boolean }) => Promise<void>
  /** 本群发言人（尚未标记为同事的，按证据条数排序）：供「批量标记同事」 */
  groupSenders: Array<{ username: string; name: string; count: number }>
  groupSendersLoading: boolean
  /** 拉取本群发言人候选（懒加载：展开面板时才请求） */
  loadGroupSenders: () => Promise<void>
  /** 批量标记同事：逐条写入 team_member，并把已加载消息就地打标 */
  markSendersTeam: (usernames: string[]) => Promise<void>
  /** 清理群问题状态（切到非群会话/换账号时） */
  resetGroupState: () => void
  /** 清空当前群全部问题记录(含已解决/归档与证据,不可恢复);随后可手动重新分析 */
  clearGroupAll: () => Promise<void>
  /** 刷新各群 open 计数（会话列表徽标） */
  refreshGroupBadges: () => Promise<void>
  /** 把指定成员标记/取消为团队客服（本地即时生效，重载消息后持久一致） */
  setMsgSenderTeam: (username: string, on: boolean) => Promise<void>
  /** 定位到某问题发生时间附近：切群 + 加载历史直到覆盖目标时间 + 提示消息区滚动 */
  locateIssueAt: (sessionId: string, targetMs: number) => Promise<void>
  /** 页面导航 */
  setPage: (page: WorkbenchPage) => void
  /** 从客户页/看板跳转到指定会话（切到对话页并选中） */
  gotoSession: (sessionId: string) => void
}

const wxApi = window.api?.cs?.wx
const aiApi = window.api?.cs?.ai
const replyApi = window.api?.cs?.reply
const agentApi = window.api?.cs?.agent
const issueApi = window.api?.cs?.issue

/** 问题详情请求序号：防止慢响应覆盖用户后点击的展开行 */
let detailReqSeq = 0

/**
 * 会话列表浅比较：内容一致时复用旧数组引用。
 * sessions 被 App/TitleBar/SessionList/看板/客户页订阅，换引用会让它们全部重渲染。
 */
function sameSessions(a: SessionSummary[], b: SessionSummary[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (
      x.username !== y.username ||
      x.displayName !== y.displayName ||
      x.avatarUrl !== y.avatarUrl ||
      x.remark !== y.remark ||
      x.nickname !== y.nickname ||
      x.unreadCount !== y.unreadCount ||
      x.lastTimestamp !== y.lastTimestamp ||
      x.sortTimestamp !== y.sortTimestamp ||
      x.summary !== y.summary ||
      x.isPinned !== y.isPinned ||
      x.isCollapsed !== y.isCollapsed ||
      x.lastMsgIsSend !== y.lastMsgIsSend
    ) {
      return false
    }
  }
  return true
}

/** 会话列表在途请求：3 个页面各自订阅 dbChanged，合并成同一时刻只发一次 IPC */
let sessionsInFlight: { wxid: string; promise: Promise<void> } | null = null

export const useWorkbenchStore = create<WorkbenchState>((set, get) => ({
  // 启动默认停在左侧导航第一个菜单(App.tsx NAV_ITEMS[0] = AI 工作台)
  page: 'workbench',
  wxid: null,
  source: 'empty',
  sessions: [],
  activeSessionId: null,
  messages: [],
  loading: false,
  messagesHasMore: false,
  nextCursor: null,
  loadingOlder: false,
  fallbackReason: null,

  suggestions: [],
  suggestLoading: false,
  suggestError: null,
  chosenText: null,

  agents: [],
  defaultAgentId: null,
  suggestAutoKey: null,
  suggestAutoAt: 0,

  groupIssues: [],
  groupCoverage: null,
  groupExcluded: false,
  groupSenders: [],
  groupSendersLoading: false,
  groupIssueLoading: false,
  groupAnalyzing: false,
  groupIssueError: null,
  groupAnalyzedAt: null,
  groupDays: 2,
  groupActiveDetail: null,
  groupDetailLoading: false,
  groupBadges: {},
  scrollHint: null,

  sending: false,
  sendResult: null,

  init: async (wxid: string) => {
    set({ wxid, loading: true })
    try {
      if (wxApi) {
        const sessionsRes = await wxApi.getSessions(wxid)
        if (sessionsRes.ok && sessionsRes.sessions && sessionsRes.sessions.length > 0) {
          set({
            source: 'wx',
            sessions: sessionsRes.sessions,
            fallbackReason: null,
            loading: false
          })
          void get().refreshGroupBadges()
          return
        }
        set({
          source: 'empty',
          sessions: [],
          fallbackReason: sessionsRes.ok
            ? '当前账号暂无会话数据'
            : sessionsRes.error || '未获取到微信数据',
          loading: false
        })
        return
      }
    } catch (e) {
      console.error('[workbench] init failed', e)
    }
    set({
      source: 'empty',
      sessions: [],
      fallbackReason: '微信通道未就绪，请先在 设置 → 微信数据与密钥 连接',
      loading: false
    })
  },

  selectSession: async (sessionId: string) => {
    set({ activeSessionId: sessionId, loading: true, nextCursor: null, messagesHasMore: false })
    void get().loadAgents()
    // 群会话联动右侧「群问题」视图（自动读取 + 窗口分析）；非群清理
    const picked = get().sessions.find((s) => s.username === sessionId)
    if (picked?.isGroup) void get().loadGroupIssues(sessionId)
    else get().resetGroupState()
    const { wxid, source } = get()
    try {
      if (source === 'wx' && wxid && wxApi) {
        const res = await wxApi.getMessages(wxid, sessionId, 50)
        if (res.ok && res.messages) {
          set({
            messages: res.messages,
            messagesHasMore: !!res.hasMore,
            nextCursor: res.nextCursor ?? null,
            loading: false
          })
          void get().considerSuggestAuto()
          return
        }
      }
      set({ messages: [], loading: false, messagesHasMore: false, nextCursor: null })
    } catch (e) {
      console.error('[workbench] load messages failed', e)
      set({ messages: [], loading: false, messagesHasMore: false, nextCursor: null })
    }
    void get().refreshGroupBadges()
  },

  refreshSessions: async () => {
    const { wxid, source } = get()
    if (source !== 'wx' || !wxid || !wxApi) return
    // 同一账号的并发刷新合并为一次（SessionList/客户页/看板各自订阅 dbChanged）
    if (sessionsInFlight && sessionsInFlight.wxid === wxid) return sessionsInFlight.promise
    const promise = (async (): Promise<void> => {
      try {
        const res = await wxApi.getSessions(wxid)
        if (!res.ok || !res.sessions) return
        set((s) => (sameSessions(s.sessions, res.sessions!) ? s : { sessions: res.sessions! }))
        void get().refreshGroupBadges()
      } finally {
        if (sessionsInFlight?.wxid === wxid) sessionsInFlight = null
      }
    })()
    sessionsInFlight = { wxid, promise }
    return promise
  },

  loadAgents: async () => {
    if (!agentApi) return
    try {
      const res = await agentApi.list()
      if (res.ok && res.agents && res.agents.length > 0) {
        // 统一人设：agents 仅用于展示，defaultAgentId 即全局当前生效人设（无切换概念）
        set({ agents: res.agents, defaultAgentId: res.defaultId ?? res.agents[0].id })
      }
    } catch (e) {
      console.error('[workbench] load agents failed', e)
    }
  },

  // ── 群问题（右栏「群问题」视图；与看板同源 issue_feedback）──

  loadGroupIssues: async (sessionId: string) => {
    const { wxid } = get()
    const session = get().sessions.find((s) => s.username === sessionId)
    if (!wxid || !session?.isGroup) return
    const groupName = session.displayName || session.nickname || ''
    // 1) 立即读本地问题列表（秒开；分析完成后会刷新）
    set({
      groupIssueLoading: true,
      groupIssueError: null,
      groupActiveDetail: null,
      groupCoverage: null
    })
    const listRes = await issueApi?.listGroup(wxid, sessionId).catch(() => null)
    if (get().activeSessionId !== sessionId) return
    const excludedNow = !!(listRes?.ok && listRes.excluded)
    set({
      groupIssues: (listRes?.ok && listRes.issues ? listRes.issues : []) as FeedbackIssue[],
      groupExcluded: excludedNow,
      groupIssueLoading: false,
      groupIssueError: listRes && !listRes.ok ? (listRes.error ?? '读取问题列表失败') : null
    })
    // 已排除监控的群不做自动提取（否则一点进群就把噪音提回来了）；手动「重新分析」仍可用
    if (excludedNow) {
      set({ groupAnalyzing: false })
      return
    }
    // 2) 自动窗口分析（主进程侧节流：2 分钟内已尝试则 skipped）
    set({ groupAnalyzing: true })
    const an = await issueApi
      ?.analyzeGroup(wxid, sessionId, groupName || undefined, { days: get().groupDays })
      .catch(() => null)
    if (get().activeSessionId !== sessionId) return
    set({
      groupAnalyzing: false,
      groupAnalyzedAt: an?.ok && an.lastAt ? an.lastAt : get().groupAnalyzedAt,
      groupCoverage: an?.coverage ?? get().groupCoverage,
      groupIssueError: an
        ? an.ok
          ? an.skipped
            ? (an.error ?? get().groupIssueError)
            : null
          : (an.error ?? '分析失败')
        : get().groupIssueError
    })
    // 3) 有新产出时重读列表
    if (an?.ok && !an.skipped) await get().refreshGroupIssues()
  },

  analyzeGroupNow: async (opts?: { reset?: boolean }) => {
    const { wxid, activeSessionId } = get()
    if (!wxid || !activeSessionId) return
    const session = get().sessions.find((s) => s.username === activeSessionId)
    if (!session?.isGroup) return
    const groupName = session.displayName || session.nickname || ''
    set({ groupAnalyzing: true, groupIssueError: null, groupCoverage: null })
    const an = await issueApi
      ?.analyzeGroup(wxid, activeSessionId, groupName || undefined, {
        force: true,
        days: get().groupDays,
        reset: opts?.reset
      })
      .catch(() => null)
    if (get().activeSessionId !== activeSessionId) return
    set({
      groupAnalyzing: false,
      groupAnalyzedAt: an?.ok && an.lastAt ? an.lastAt : get().groupAnalyzedAt,
      groupCoverage: an?.coverage ?? null,
      groupIssueError: an && !an.ok ? (an.error ?? '分析失败') : null
    })
    if (an?.ok) await get().refreshGroupIssues()
  },

  setGroupDays: (days: number) => {
    const d = Math.min(Math.max(Math.floor(days), 1), 7)
    set({ groupDays: d })
    const { wxid, activeSessionId } = get()
    const session = activeSessionId
      ? get().sessions.find((s) => s.username === activeSessionId)
      : undefined
    if (wxid && session?.isGroup) void get().analyzeGroupNow()
  },

  refreshGroupIssues: async () => {
    const { wxid, activeSessionId } = get()
    if (!wxid || !activeSessionId) return
    const res = await issueApi?.listGroup(wxid, activeSessionId).catch(() => null)
    if (get().activeSessionId !== activeSessionId) return
    if (res?.ok && res.issues) {
      set({ groupIssues: res.issues as FeedbackIssue[], groupExcluded: !!res.excluded })
    }
    void get().refreshGroupBadges()
  },

  openGroupIssue: async (id: number | null) => {
    if (id === null) {
      detailReqSeq++
      set({ groupActiveDetail: null, groupDetailLoading: false })
      return
    }
    const seq = ++detailReqSeq
    set({ groupDetailLoading: true })
    const res = await issueApi?.detail(id).catch(() => null)
    if (seq !== detailReqSeq) return // 期间已打开/关闭其它行，丢弃慢响应
    set({
      groupDetailLoading: false,
      groupActiveDetail: (res?.ok && res.issue ? res.issue : null) as FeedbackIssueDetail | null
    })
  },

  setGroupIssueStatus: async (id: number, status: FeedbackIssueStatus) => {
    // 本地即时生效（乐观更新）
    set((s) => ({
      groupIssues: s.groupIssues.map((it) => (it.id === id ? { ...it, status } : it)),
      groupActiveDetail:
        s.groupActiveDetail && s.groupActiveDetail.id === id
          ? { ...s.groupActiveDetail, status }
          : s.groupActiveDetail
    }))
    const res = await issueApi?.setStatus(id, status).catch(() => null)
    if (!res?.ok) {
      toast.error(res?.error || '状态更新失败')
      void get().refreshGroupIssues() // 回滚为真实状态
    }
  },

  /** 疑似确认：核实为真问题 → 移出疑似桶并计入正式待办 */
  setGroupScope: async (excluded: boolean, opts?: { archiveOpen?: boolean }) => {
    const { wxid, activeSessionId } = get()
    if (!wxid || !activeSessionId) return
    // preload 未更新时该桥不存在：给出明确提示，避免「点了没反应」
    if (typeof issueApi?.setGroupScope !== 'function') {
      toast.error('当前运行的版本较旧：请完全退出应用后重新启动再试')
      return
    }
    const res = await issueApi
      ?.setGroupScope(wxid, activeSessionId, excluded, opts)
      .catch(() => null)
    if (!res?.ok) {
      toast.error(res?.error || '群监控开关设置失败')
      return
    }
    set({ groupExcluded: excluded })
    if (excluded) {
      toast.success(
        res.archived
          ? `本群已排除监控，归档 ${res.archived} 条待处理记录`
          : '本群已排除监控（不再自动提取/跟进）'
      )
    } else {
      toast.success('本群已恢复监控：下次自动分析会重新提取（历史归档记录需手动重开）')
    }
    await get().refreshGroupIssues()
    void get().refreshGroupBadges()
  },

  loadGroupSenders: async () => {
    const { wxid, activeSessionId } = get()
    if (!wxid || !activeSessionId) return
    if (typeof issueApi?.groupSenders !== 'function') return
    set({ groupSendersLoading: true })
    const res = await issueApi.groupSenders(wxid, activeSessionId).catch(() => null)
    if (get().activeSessionId !== activeSessionId) return
    set({
      groupSendersLoading: false,
      groupSenders: res?.ok && res.senders ? res.senders : []
    })
  },

  markSendersTeam: async (usernames: string[]) => {
    const { wxid } = get()
    const teamApi = window.api?.cs?.team
    const list = usernames.filter(Boolean)
    if (!wxid || !teamApi || list.length === 0) return
    // 逐个写入（team_member 是全局名单，量小；单个失败不影响其余）
    const results = await Promise.all(list.map((u) => teamApi.save(wxid, u).catch(() => null)))
    const done = list.filter((_, i) => results[i]?.ok)
    if (done.length === 0) {
      toast.error('标记失败，请重试')
      return
    }
    set((s) => ({
      messages: s.messages.map((m) =>
        m.senderUsername && done.includes(m.senderUsername) ? { ...m, senderIsTeam: true } : m
      ),
      groupSenders: s.groupSenders.filter((x) => !done.includes(x.username))
    }))
    toast.success(
      `已标记 ${done.length} 位同事为团队客服：TA 们的发言会算作我方回复` +
        (done.length < list.length ? `（${list.length - done.length} 位失败，可重试）` : '')
    )
  },

  assignGroupIssue: async (id: number, username: string | null) => {
    const assignee = username ?? undefined
    set((s) => ({
      groupIssues: s.groupIssues.map((it) => (it.id === id ? { ...it, assignee } : it)),
      groupActiveDetail:
        s.groupActiveDetail && s.groupActiveDetail.id === id
          ? { ...s.groupActiveDetail, assignee }
          : s.groupActiveDetail
    }))
    const res = await issueApi?.assign(id, username).catch(() => null)
    if (!res?.ok) {
      toast.error(res?.error || '跟进人设置失败')
      void get().refreshGroupIssues() // 回滚为真实状态
    }
  },

  confirmGroupIssue: async (id: number) => {
    set((s) => ({
      groupIssues: s.groupIssues.map((it) => (it.id === id ? { ...it, needConfirm: false } : it)),
      groupActiveDetail:
        s.groupActiveDetail && s.groupActiveDetail.id === id
          ? { ...s.groupActiveDetail, needConfirm: false }
          : s.groupActiveDetail
    }))
    const res = await issueApi?.confirmDoubt(id).catch(() => null)
    if (!res?.ok) {
      toast.error(res?.error || '确认失败')
      void get().refreshGroupIssues()
    } else {
      void get().refreshGroupIssues()
      void get().refreshGroupBadges()
    }
  },

  resetGroupState: () => {
    detailReqSeq++
    set({
      groupIssues: [],
      groupCoverage: null,
      groupExcluded: false,
      groupSenders: [],
      groupSendersLoading: false,
      groupIssueLoading: false,
      groupAnalyzing: false,
      groupIssueError: null,
      groupAnalyzedAt: null,
      groupActiveDetail: null,
      groupDetailLoading: false
    })
  },

  clearGroupAll: async () => {
    const { wxid, activeSessionId } = get()
    if (!wxid || !activeSessionId) return
    const res = await issueApi?.clearGroup(wxid, activeSessionId).catch(() => null)
    if (!res?.ok) {
      toast.error(res?.error || '清空失败')
      return
    }
    detailReqSeq++
    set({
      groupIssues: [],
      groupActiveDetail: null,
      groupDetailLoading: false,
      groupAnalyzedAt: null
    })
    // 闭环:清空即按当前窗口从零重新提取(主进程侧已复位该群水位,失败也可手动重试)
    await get().analyzeGroupNow()
    void get().refreshGroupBadges()
  },

  refreshGroupBadges: async () => {
    const { wxid, source } = get()
    if (source !== 'wx' || !wxid || !issueApi) return
    const res = await issueApi.groupBadges(wxid).catch(() => null)
    if (res?.ok && res.badges) set({ groupBadges: res.badges })
  },

  setMsgSenderTeam: async (username: string, on: boolean) => {
    const { wxid } = get()
    if (!wxid || !username) return
    const teamApi = window.api?.cs?.team
    const res = on
      ? await teamApi?.save(wxid, username).catch(() => null)
      : await teamApi?.remove(wxid, username).catch(() => null)
    if (!res?.ok) {
      toast.error(res?.error || '操作失败')
      return
    }
    // 本地即时生效；下次会话加载（enrich）后全量一致
    set((s) => ({
      messages: s.messages.map((m) =>
        m.senderUsername === username ? { ...m, senderIsTeam: on } : m
      )
    }))
    toast.success(on ? '已标记为团队客服（全局生效）' : '已移出团队客服')
  },

  locateIssueAt: async (sessionId: string, targetMs: number) => {
    const { wxid, page } = get()
    if (!wxid) return
    if (page !== 'chat' || get().activeSessionId !== sessionId) {
      await get().selectSession(sessionId)
      get().setPage('chat')
    }
    // 逐页加载更早消息，直到「最旧已加载消息」不晚于目标时间（窗口覆盖目标即停；上限 15 页防爆）
    for (let i = 0; i < 15; i++) {
      const { messages, messagesHasMore, nextCursor, loadingOlder } = get()
      if (messages.length === 0) break
      if (messages[messages.length - 1].createTime <= targetMs) break
      if (!messagesHasMore || !nextCursor || loadingOlder) break
      await get().loadOlder()
    }
    set({ scrollHint: { sessionId, targetMs, nonce: Date.now() } })
  },

  loadOlder: async () => {
    const { wxid, activeSessionId, nextCursor, loadingOlder, source } = get()
    if (source !== 'wx' || !wxid || !activeSessionId || !nextCursor || loadingOlder || !wxApi)
      return
    set({ loadingOlder: true })
    try {
      const res = await wxApi.getMessages(wxid, activeSessionId, 50, nextCursor)
      // 防竞态：加载期间用户切走了会话则丢弃结果
      if (get().activeSessionId !== activeSessionId) return
      if (res.ok && res.messages && res.messages.length > 0) {
        set({
          messages: [...res.messages, ...get().messages],
          messagesHasMore: !!res.hasMore,
          nextCursor: res.nextCursor ?? null
        })
      } else {
        set({ messagesHasMore: false, nextCursor: null })
      }
    } catch (e) {
      console.error('[workbench] load older failed', e)
    } finally {
      if (get().activeSessionId === activeSessionId) set({ loadingOlder: false })
    }
  },

  refreshCurrentMessages: async () => {
    const { wxid, activeSessionId, source, messages } = get()
    if (source !== 'wx' || !wxid || !activeSessionId || !wxApi) return
    if (messages.length === 0) return // 尚未加载的会话交给 selectSession 处理,避免灌入全量历史
    // 水位 = 最后一条真实消息(本地发送占位 local-* 不计,避免漏掉并发到达的远端消息)
    let sinceSortSeq = 0
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.serverId && !m.serverId.startsWith('local-')) {
        sinceSortSeq = m.sortSeq
        break
      }
    }
    if (sinceSortSeq === 0) return
    const res = await wxApi.getMessagesSince(wxid, activeSessionId, sinceSortSeq).catch(() => null)
    // 防竞态：刷新期间用户切走了会话则丢弃结果
    if (get().activeSessionId !== activeSessionId) return
    if (res?.ok && res.messages && res.messages.length > 0) {
      const have = new Set(get().messages.map((m) => m.serverId || `l:${m.localId}`))
      const fresh = res.messages.filter((m) => !have.has(m.serverId || `l:${m.localId}`))
      if (fresh.length > 0) {
        set({ messages: [...get().messages, ...fresh] })
        // 新消息到达:若对方刚发言,满足节流则自动生成建议(同一消息不重复触发)
        void get().considerSuggestAuto(true)
      }
    }
  },

  /** 依据「最新一条为对方消息」自动生成建议;同一消息去重,推送路径 ≥8s 节流 */
  considerSuggestAuto: (quiet) => {
    const { wxid, activeSessionId, messages, suggestLoading } = get()
    if (!wxid || !activeSessionId || suggestLoading || messages.length === 0) return
    const last = messages[messages.length - 1]
    if (!last || last.isSend) return // 最新是我方消息(或会话为空):不自动生成
    const text = last.parsedContent?.trim()
    if (!text) return // 非文本(图片等)不触发
    const key = `${activeSessionId}::${last.serverId || `l:${last.localId}`}`
    if (key === get().suggestAutoKey) return
    if (quiet && Date.now() - (get().suggestAutoAt || 0) < 8000) return
    set({ suggestAutoKey: key, suggestAutoAt: Date.now() })
    void get().generateSuggestions()
  },

  generateSuggestions: async () => {
    const { wxid, activeSessionId, sessions, messages } = get()
    if (!wxid || !activeSessionId || messages.length === 0) return
    const session = sessions.find((s) => s.username === activeSessionId)
    const sessionName =
      session?.displayName || session?.nickname || session?.remark || activeSessionId
    set({ suggestLoading: true, suggestError: null, chosenText: null })
    try {
      if (aiApi) {
        // 统一人设：不传 agentId，主进程按默认（当前生效）人设生成
        const res = await aiApi.generateReply(wxid, activeSessionId, sessionName, messages, {})
        // 防竞态：生成期间用户切走了会话则丢弃结果
        if (get().activeSessionId !== activeSessionId) return
        if (res.ok && res.candidates && res.candidates.length > 0) {
          set({ suggestions: res.candidates, suggestLoading: false })
          return
        }
        set({ suggestions: [], suggestError: res.error || '未生成建议', suggestLoading: false })
        return
      }
    } catch (e) {
      console.error('[workbench] generate suggestions failed', e)
    }
    if (get().activeSessionId !== activeSessionId) return
    set({ suggestions: [], suggestError: 'AI 通道未就绪', suggestLoading: false })
  },

  adoptSuggestion: (text: string) => {
    // T8：选用建议即触发发送（走主进程全局串行队列）
    set({ chosenText: text })
    void get().sendText(text)
  },

  sendText: async (text: string, source?: string) => {
    const { wxid, activeSessionId, sessions } = get()
    if (!wxid || !activeSessionId || !text.trim()) return
    const session = sessions.find((s) => s.username === activeSessionId)
    const targetName =
      session?.displayName || session?.nickname || session?.remark || activeSessionId
    set({ sending: true })
    try {
      let res: {
        ok: boolean
        result?: { status: string; verified?: boolean; error?: string }
        error?: string
      }
      if (replyApi) {
        res = await replyApi.sendText({
          wxid,
          sessionId: activeSessionId,
          targetName,
          text: text.trim(),
          source
        })
      } else {
        res = { ok: false, error: '发送通道未就绪' }
      }
      const result = res.ok && res.result ? res.result : null
      if (res.ok && res.result?.status === 'sent') {
        // 本地追加已发送消息（真实库模式下稍后由监控推送对齐）
        const msg: ChatMessage = {
          localId: Date.now(),
          serverId: `local-${Date.now()}`,
          serverSeq: Date.now(),
          localType: 1,
          createTime: Date.now(),
          sortSeq: Date.now(),
          isSend: true,
          senderUsername: wxid,
          parsedContent: text.trim(),
          rawContent: text.trim()
        }
        set({ messages: [...get().messages, msg] })
        toast.success(res.result.verified ? '已发送' : '已发送（待校验）')
        // 稍后拉取真实消息列表,以微信库中的正式气泡替换本地乐观行
        window.setTimeout(() => {
          const st = get()
          if (st.source === 'wx' && st.activeSessionId === activeSessionId && !st.sending) {
            void st.refreshCurrentMessages()
          }
        }, 1600)
      } else {
        toast.error(res.error || result?.error || '发送失败')
      }
      set({
        sending: false,
        sendResult: {
          ok: res.ok,
          error: res.error || result?.error,
          status: result?.status,
          verified: result?.verified
        }
      })
    } catch (e) {
      console.error('[workbench] send failed', e)
      toast.error('发送失败')
      set({ sending: false, sendResult: { ok: false, error: '发送失败', status: 'failed' } })
    }
  },

  /** 发送单条图片/文件(走主进程同一串行队列;文件消息不在本地乐观回显,由监控推送对齐) */
  sendFile: async (path: string, kind: 'image' | 'file') => {
    const { wxid, activeSessionId, sessions, sending } = get()
    if (!wxid || !activeSessionId || !path.trim() || sending) return
    const session = sessions.find((s) => s.username === activeSessionId)
    const targetName =
      session?.displayName || session?.nickname || session?.remark || activeSessionId
    set({ sending: true })
    try {
      const res = replyApi
        ? await replyApi.sendFile({
            wxid,
            sessionId: activeSessionId,
            targetName,
            path: path.trim(),
            kind,
            source: 'manual'
          })
        : { ok: false, error: '发送通道未就绪' }
      const result = res.ok && res.result ? res.result : null
      const name = path.split(/[\\/]/).pop() ?? ''
      if (res.ok && res.result?.status === 'sent') {
        toast.success(
          res.result.verified ? `${kind === 'image' ? '图片' : '文件'}已发送` : '已发送(待校验)'
        )
        // 1.6s 后拉取真实消息(微信库落盘稍慢),让文件/图片正式气泡上屏
        window.setTimeout(() => {
          const st = get()
          if (st.source === 'wx' && st.activeSessionId === activeSessionId && !st.sending) {
            void st.refreshCurrentMessages()
          }
        }, 1600)
      } else {
        toast.error(res.error || result?.error || `发送失败:${name}`)
      }
      set({
        sending: false,
        sendResult: {
          ok: res.ok,
          error: res.error || result?.error,
          status: result?.status,
          verified: result?.verified
        }
      })
    } catch (e) {
      console.error('[workbench] sendFile failed', e)
      toast.error('文件发送失败')
      set({ sending: false, sendResult: { ok: false, error: '发送失败', status: 'failed' } })
    }
  },

  setPage: (page: WorkbenchPage) => {
    set({ page })
  },

  gotoSession: (sessionId: string) => {
    set({ page: 'chat' })
    void get().selectSession(sessionId)
  }
}))
