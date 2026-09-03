import { create } from 'zustand'
import type {
  ChatMessage,
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
export type WorkbenchPage = 'chat' | 'customers' | 'dashboard' | 'settings'

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

  /** AI 建议（T7） */
  suggestions: ReplyCandidate[]
  suggestLoading: boolean
  suggestError: string | null
  suggestLlm: boolean
  /** 已选中的建议文本（T8 发送入口用） */
  chosenText: string | null

  /** 发送（T8） */
  sending: boolean
  sendResult: { ok: boolean; error?: string; status?: string; verified?: boolean } | null

  init: (wxid: string) => Promise<void>
  selectSession: (sessionId: string) => Promise<void>
  refreshSessions: () => Promise<void>
  loadOlder: () => Promise<void>
  generateSuggestions: () => Promise<void>
  adoptSuggestion: (text: string) => void
  sendText: (text: string, source?: string) => Promise<void>
  /** 页面导航 */
  setPage: (page: WorkbenchPage) => void
  /** 从客户页/看板跳转到指定会话（切到对话页并选中） */
  gotoSession: (sessionId: string) => void
}

const wxApi = window.api?.cs?.wx
const aiApi = window.api?.cs?.ai
const replyApi = window.api?.cs?.reply

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
  suggestLlm: false,
  chosenText: null,

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
  },

  refreshSessions: async () => {
    const { wxid, source } = get()
    if (source !== 'wx' || !wxid || !wxApi) return
    const res = await wxApi.getSessions(wxid)
    if (res.ok && res.sessions) {
      set({ sessions: res.sessions })
    }
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
    const { activeSessionId, sessions, messages } = get()
    if (!activeSessionId || messages.length === 0) return
    const session = sessions.find((s) => s.username === activeSessionId)
    const sessionName = session?.displayName || session?.nickname || session?.remark || activeSessionId
    set({ suggestLoading: true, suggestError: null, chosenText: null })
    try {
      if (aiApi) {
        const res = await aiApi.generateReply(sessionName, messages)
        // 防竞态：生成期间用户切走了会话则丢弃结果
        if (get().activeSessionId !== activeSessionId) return
        if (res.ok && res.candidates && res.candidates.length > 0) {
          set({ suggestions: res.candidates, suggestLlm: !!res.llm, suggestLoading: false })
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
