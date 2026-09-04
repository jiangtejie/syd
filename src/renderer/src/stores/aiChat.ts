import { create } from 'zustand'
import type { AiAgent, AiChatEvent, ChatMsgItem, ChatSessionItem } from '../../../shared/types'
import { toast } from './toast'

/**
 * AI 助手页状态(会话/流式缓冲/工具卡;页面级单例)。
 */

const aiChatApi = window.api?.cs?.aiChat
const agentApi = window.api?.cs?.agent

export interface ToolCard {
  id: number
  name: string
  status: 'start' | 'pending' | 'done' | 'fail'
  args?: string
  result?: string
  runId?: string
}

interface AiChatState {
  wxid: string
  chats: ChatSessionItem[]
  agents: AiAgent[]
  defaultAgentId: string | null
  activeId: number | null
  messages: ChatMsgItem[]
  loading: boolean
  busy: boolean
  streamingBuf: string
  error: string | null
  toolCards: ToolCard[]
  agentId: string | null
  lastEventSeq: number
  // actions
  init: (wxid: string) => Promise<void>
  selectChat: (id: number | null) => Promise<void>
  newChat: () => void
  send: (text: string) => Promise<void>
  stop: () => Promise<void>
  retry: () => Promise<void>
  renameChat: (id: number, title: string) => Promise<void>
  removeChat: (id: number) => Promise<void>
  clearChat: () => Promise<void>
  chooseAgent: (agentId: string | null) => Promise<void>
  confirmTool: (runId: string, ok: boolean) => Promise<void>
  refreshChatList: () => Promise<void>
  subscribe: () => () => void
}

let toolSeq = 0

export const useAiChatStore = create<AiChatState>((set, get) => ({
  wxid: '',
  chats: [],
  agents: [],
  defaultAgentId: null,
  activeId: null,
  messages: [],
  loading: false,
  busy: false,
  streamingBuf: '',
  error: null,
  toolCards: [],
  agentId: null,
  lastEventSeq: 0,

  init: async (wxid) => {
    set({ wxid, streamingBuf: '', error: null })
    const [chatRes, agentRes] = await Promise.all([
      aiChatApi?.listChats(wxid).catch(() => null),
      agentApi?.list().catch(() => null)
    ])
    if (agentRes?.ok && agentRes.agents && agentRes.agents.length > 0) {
      const list = agentRes.agents as AiAgent[]
      const def = agentRes.defaultId ?? list[0].id
      set({ agents: list, defaultAgentId: def, agentId: def })
    }
    if (chatRes?.ok && chatRes.chats) {
      set({ chats: chatRes.chats as ChatSessionItem[] })
    }
  },

  selectChat: async (id) => {
    set({ activeId: id, messages: [], streamingBuf: '', toolCards: [], error: null, busy: false })
    if (id === null) return
    set({ loading: true })
    const [msgRes, chatMeta] = await Promise.all([
      aiChatApi?.messages(id).catch(() => null),
      Promise.resolve(get().chats.find((c) => c.id === id))
    ])
    if (msgRes?.ok && msgRes.messages) {
      set({ messages: msgRes.messages as ChatMsgItem[] })
    }
    set({ agentId: chatMeta?.agentId ?? get().defaultAgentId, loading: false })
  },

  newChat: () => {
    set({ activeId: null, messages: [], streamingBuf: '', toolCards: [], error: null, busy: false })
  },

  send: async (text) => {
    const { wxid, activeId, agentId } = get()
    const trimmed = (text || '').trim()
    if (!trimmed) return
    if (!wxid) {
      set({ error: '未连接微信账号,请先到 设置 → 微信数据与密钥 连接' })
      return
    }
    if (get().busy) {
      toast.error('正在生成中,请等待或停止')
      return
    }
    set({ busy: true, error: null, streamingBuf: '', toolCards: [] })
    const res = await aiChatApi
      ?.send({ wxid, chatId: activeId ?? undefined, agentId, text: trimmed })
      .catch(() => null)
    if (!res?.ok) {
      set({ busy: false, error: (res as { error?: string } | null)?.error || '发送失败' })
      return
    }
    // 新会话:主进程已建,刷新会话列表并激活
    if (!activeId && res.chatId) {
      set({ activeId: res.chatId })
      const chatRes = await aiChatApi?.listChats(wxid).catch(() => null)
      if (chatRes?.ok && chatRes.chats) {
        set({ chats: chatRes.chats as ChatSessionItem[] })
      }
      // 若选择了非默认智能体,绑定到新会话
      if (agentId && agentId !== get().defaultAgentId) {
        void aiChatApi?.setAgent(res.chatId, agentId)
      }
    }
    // 用户消息先本地置顶(主进程落库稍后与事件对齐)
    set((s) => ({
      messages: [
        ...s.messages,
        {
          id: Date.now() * -1,
          sessionId: res.chatId ?? 0,
          role: 'user',
          kind: 'text',
          content: trimmed,
          createdAt: Date.now()
        } as ChatMsgItem
      ]
    }))
    if (!activeId) {
      void get().refreshChatList()
    }
  },

  stop: async () => {
    const { wxid, activeId } = get()
    if (!activeId) return
    await aiChatApi?.stop(wxid, activeId).catch(() => null)
  },

  retry: async () => {
    const { wxid, activeId, agentId } = get()
    if (!activeId || get().busy) return
    set({ busy: true, error: null, streamingBuf: '', toolCards: [] })
    const res = await aiChatApi?.retry(wxid, activeId, agentId).catch(() => null)
    if (!res?.ok) {
      set({ busy: false, error: (res as { error?: string } | null)?.error || '重试失败' })
    }
  },

  renameChat: async (id, title) => {
    const res = await aiChatApi?.renameChat(id, title).catch(() => null)
    if (res?.ok) {
      set((s) => ({
        chats: s.chats.map((c) => (c.id === id ? { ...c, title: title.trim() || c.title } : c))
      }))
    }
  },

  removeChat: async (id) => {
    // 若删除的是正在生成的会话,先让主进程中止该 run(防孤儿任务继续写已删会话/回流事件)
    const { wxid, activeId, busy } = get()
    if (busy && activeId === id && wxid) {
      await aiChatApi?.stop(wxid, id).catch(() => null)
    }
    const res = await aiChatApi?.removeChat(id).catch(() => null)
    if (!res?.ok) return
    set((s) => {
      const chats = s.chats.filter((c) => c.id !== id)
      const nextActive = s.activeId === id ? null : s.activeId
      return {
        chats,
        activeId: nextActive,
        messages: nextActive === null ? [] : s.messages,
        streamingBuf: nextActive === null ? '' : s.streamingBuf,
        busy: nextActive === null ? false : s.busy,
        toolCards: nextActive === null ? [] : s.toolCards,
        error: nextActive === null ? null : s.error
      }
    })
  },

  clearChat: async () => {
    const { activeId } = get()
    if (!activeId) return
    const res = await aiChatApi?.clearChat(activeId).catch(() => null)
    if (res?.ok) set({ messages: [], toolCards: [], error: null })
  },

  chooseAgent: async (agentId) => {
    set({ agentId })
    const { activeId } = get()
    if (activeId) await aiChatApi?.setAgent(activeId, agentId).catch(() => null)
  },

  confirmTool: async (runId, ok) => {
    await aiChatApi?.confirmTool(runId, ok).catch(() => null)
    set((s) => ({
      toolCards: s.toolCards.map((c) =>
        c.runId === runId ? { ...c, status: ok ? 'done' : 'fail' } : c
      )
    }))
  },

  refreshChatList: async () => {
    const { wxid } = get()
    if (!wxid) return
    const res = await aiChatApi?.listChats(wxid).catch(() => null)
    if (res?.ok && res.chats) set({ chats: res.chats as ChatSessionItem[] })
  },

  subscribe: () => {
    const handle = (evt: AiChatEvent): void => {
      const s = get()
      // 非当前会话的进度忽略;会话已删除的终态事件只复位状态,不再回流重载
      const chatExists = s.chats.some((c) => c.id === evt.chatId)
      const isCurrent = s.activeId === evt.chatId
      const resetAll = (): void => set({ streamingBuf: '', busy: false, toolCards: [] })
      if (evt.type === 'delta' && evt.token) {
        if (isCurrent) set({ streamingBuf: s.streamingBuf + evt.token })
      } else if (evt.type === 'tool') {
        if (!isCurrent) return
        const card: ToolCard = {
          id: ++toolSeq,
          name: evt.tool ?? '',
          status: evt.toolStatus ?? 'start',
          args: evt.args,
          result: evt.resultClip,
          runId: evt.toolStatus === 'pending' ? evt.text : undefined
        }
        // 同名工具新一轮执行:更新最近一张
        set((st) => {
          const idx = st.toolCards.findIndex(
            (c) => c.name === card.name && c.status !== 'done' && c.status !== 'fail'
          )
          const cards = [...st.toolCards]
          if (idx >= 0) cards[idx] = card
          else cards.push(card)
          return { toolCards: cards.slice(-8) }
        })
      } else if (evt.type === 'done') {
        resetAll()
        if (isCurrent && chatExists) void get().selectChat(evt.chatId)
        if (chatExists) void get().refreshChatList()
      } else if (evt.type === 'error') {
        resetAll()
        if (isCurrent && chatExists) {
          set({ error: evt.text ?? '生成失败' })
          void get().selectChat(evt.chatId)
        }
      } else if (evt.type === 'status') {
        if (evt.text === '已停止') {
          resetAll()
          if (isCurrent && chatExists) void get().selectChat(evt.chatId)
        }
      }
    }
    return aiChatApi?.onEvent?.(handle) ?? (() => undefined)
  }
}))
