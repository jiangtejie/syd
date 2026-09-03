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
export type WorkbenchPage = 'chat' | 'customers' | 'dashboard' | 'settings' | 'export'

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

  /** 智能体（客服人设）：当前使用的智能体 id（跨会话保留；首次进入取全局默认，默认可在设置页修改） */
  agents: AiAgent[]
  agentId: string | null
  /** 全局默认智能体 id（仅作展示用，标注“默认”） */
  defaultAgentId: string | null

  /** 群问题（右栏「群问题」视图，仅群会话；数据来自 issue_feedback，与看板同源同状态） */
  groupIssues: FeedbackIssue[]
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
  loadAgents: () => Promise<void>
  setAgentId: (id: string | null) => void
  generateSuggestions: () => Promise<void>
  adoptSuggestion: (text: string) => void
  sendText: (text: string, source?: string) => Promise<void>
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

export const useWorkbenchStore = create<WorkbenchState>((set, get) => ({
  page: 'dashboard',
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
  agentId: null,
  defaultAgentId: null,

  groupIssues: [],
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
          fallbackReason: sessionsRes.ok ? '当前账号暂无会话数据' : (sessionsRes.error || '未获取到微信数据'),
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
          void get().generateSuggestions()
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
    const res = await wxApi.getSessions(wxid)
    if (res.ok && res.sessions) {
      set({ sessions: res.sessions })
      void get().refreshGroupBadges()
    }
  },

  loadAgents: async () => {
    const { agentId } = get()
    if (!agentApi) return
    try {
      const res = await agentApi.list()
      if (res.ok && res.agents && res.agents.length > 0) {
        set({ agents: res.agents, defaultAgentId: res.defaultId ?? res.agents[0].id })
        // 当前选择失效（被删除等）时回退默认智能体；有效则保留用户的全局选择
        const valid = agentId && res.agents.some((a) => a.id === agentId)
        if (!valid) set({ agentId: res.defaultId ?? res.agents[0].id })
      }
    } catch (e) {
      console.error('[workbench] load agents failed', e)
    }
  },

  setAgentId: (id: string | null) => {
    set({ agentId: id })
    // 切换智能体即用新角色重出建议（无会话时静默）
    const { activeSessionId, messages } = get()
    if (id && activeSessionId && messages.length > 0) void get().generateSuggestions()
  },

  // ── 群问题（右栏「群问题」视图；与看板同源 issue_feedback）──

  loadGroupIssues: async (sessionId: string) => {
    const { wxid } = get()
    const session = get().sessions.find((s) => s.username === sessionId)
    if (!wxid || !session?.isGroup) return
    const groupName = session.displayName || session.nickname || ''
    // 1) 立即读本地问题列表（秒开；分析完成后会刷新）
    set({ groupIssueLoading: true, groupIssueError: null, groupActiveDetail: null })
    const listRes = await issueApi?.listGroup(wxid, sessionId).catch(() => null)
    if (get().activeSessionId !== sessionId) return
    set({
      groupIssues: (listRes?.ok && listRes.issues ? listRes.issues : []) as FeedbackIssue[],
      groupIssueLoading: false,
      groupIssueError: listRes && !listRes.ok ? (listRes.error ?? '读取问题列表失败') : null
    })
    // 2) 自动窗口分析（主进程侧节流：2 分钟内已尝试则 skipped）
    set({ groupAnalyzing: true })
    const an = await issueApi
      ?.analyzeGroup(wxid, sessionId, groupName || undefined, { days: get().groupDays })
      .catch(() => null)
    if (get().activeSessionId !== sessionId) return
    set({
      groupAnalyzing: false,
      groupAnalyzedAt: an?.ok && an.lastAt ? an.lastAt : get().groupAnalyzedAt,
      groupIssueError: an
        ? an.ok
          ? an.skipped
            ? an.error ?? get().groupIssueError
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
    set({ groupAnalyzing: true, groupIssueError: null })
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
    if (res?.ok && res.issues) set({ groupIssues: res.issues as FeedbackIssue[] })
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

  resetGroupState: () => {
    detailReqSeq++
    set({
      groupIssues: [],
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
    // 逐页加载更早消息，直到最旧消息不晚于目标时间（上限 15 页防爆）
    for (let i = 0; i < 15; i++) {
      const { messages, messagesHasMore, nextCursor, loadingOlder } = get()
      if (messages.length === 0) break
      if (messages[0].createTime <= targetMs) break
      if (!messagesHasMore || !nextCursor || loadingOlder) break
      await get().loadOlder()
    }
    set({ scrollHint: { sessionId, targetMs, nonce: Date.now() } })
  },

  loadOlder: async () => {
    const { wxid, activeSessionId, nextCursor, loadingOlder, source } = get()
    if (source !== 'wx' || !wxid || !activeSessionId || !nextCursor || loadingOlder || !wxApi) return
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

  generateSuggestions: async () => {
    const { wxid, activeSessionId, sessions, messages, agentId } = get()
    if (!wxid || !activeSessionId || messages.length === 0) return
    const session = sessions.find((s) => s.username === activeSessionId)
    const sessionName = session?.displayName || session?.nickname || session?.remark || activeSessionId
    set({ suggestLoading: true, suggestError: null, chosenText: null })
    try {
      if (aiApi) {
        const res = await aiApi.generateReply(wxid, activeSessionId, sessionName, messages, {
          agentId: agentId ?? undefined
        })
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
    const targetName = session?.displayName || session?.nickname || session?.remark || activeSessionId
    set({ sending: true })
    try {
      let res: { ok: boolean; result?: { status: string; verified?: boolean; error?: string }; error?: string }
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

  setPage: (page: WorkbenchPage) => {
    set({ page })
  },

  gotoSession: (sessionId: string) => {
    set({ page: 'chat' })
    void get().selectSession(sessionId)
  }
}))
