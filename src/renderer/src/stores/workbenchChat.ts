import { create } from 'zustand'
import type { ChatMsgItem, ChatSessionItem } from '../../../shared/types'

/** AI 工作台前端 store(事件通道 ai:wb;会话复用 chat 体系)。 */

export interface WbToolCard {
  id: string
  name: string
  status: 'start' | 'pending' | 'done' | 'fail'
  args?: string
  result?: string
}

export interface WbApprovalCard {
  runId: string
  tool: string
  args?: string
  approvalText?: string
}

interface WbState {
  wxid: string
  chats: ChatSessionItem[] | null
  activeId: number | null
  messages: ChatMsgItem[]
  loading: boolean
  busy: boolean
  streamingBuf: string
  toolCards: WbToolCard[]
  approvals: WbApprovalCard[]
  error: string | null

  init: (wxid: string) => Promise<void>
  load: (id: number) => Promise<void>
  select: (id: number) => Promise<void>
  create: (title: string) => Promise<number | null>
  remove: (id: number) => Promise<void>
  rename: (id: number, title: string) => Promise<void>
  clear: (id: number) => Promise<void>
  send: (text: string) => Promise<void>
  retry: () => Promise<void>
  stop: () => Promise<void>
  approve: (runId: string, ok: boolean) => Promise<void>
  resetActive: () => void
}

const wbApi = window.api?.cs?.wb

export const useWorkbenchChatStore = create<WbState>((set, get) => ({
  wxid: '',
  chats: null,
  activeId: null,
  messages: [],
  loading: false,
  busy: false,
  streamingBuf: '',
  toolCards: [],
  approvals: [],
  error: null,

  init: async (wxid) => {
    set({
      wxid: wxid || '',
      busy: false,
      streamingBuf: '',
      toolCards: [],
      approvals: [],
      error: null
    })
    const res = await wbApi?.listChats(wxid || '').catch(() => null)
    if (res?.ok && res.chats) {
      const chats = res.chats as ChatSessionItem[]
      set({ chats })
      if (get().activeId === null && chats.length > 0) {
        await get().select(chats[0].id)
      }
    } else {
      set({ chats: [] })
    }
  },

  load: async (id) => {
    const res = await wbApi?.messages(id).catch(() => null)
    if (res?.ok && res.messages) {
      set({ messages: res.messages as ChatMsgItem[], loading: false })
    } else {
      set({ loading: false, error: (res as { error?: string } | null)?.error ?? '加载失败' })
    }
  },

  select: async (id) => {
    const prev = get().activeId
    set({ activeId: id, toolCards: [], approvals: [], streamingBuf: '', error: null })
    if (prev !== id) set({ messages: [], loading: true })
    await get().load(id)
  },

  create: async (title) => {
    const res = await wbApi?.create(get().wxid, title).catch(() => null)
    if (!res?.ok || res.id === undefined) return null
    await get().init(get().wxid)
    void get().select(res.id)
    return res.id
  },

  remove: async (id) => {
    const res = await wbApi?.remove(id).catch(() => null)
    if (!res?.ok) return
    const next = (get().chats ?? []).filter((c) => c.id !== id)
    set({ chats: next })
    if (get().activeId === id) {
      if (next.length > 0) void get().select(next[0].id)
      else get().resetActive()
    }
  },

  rename: async (id, title) => {
    const res = await wbApi?.rename(id, title).catch(() => null)
    if (!res?.ok) return
    set({ chats: (get().chats ?? []).map((c) => (c.id === id ? { ...c, title } : c)) })
  },

  clear: async (id) => {
    const res = await wbApi?.clear(id).catch(() => null)
    if (res?.ok) await get().load(id)
  },

  resetActive: () => {
    set({
      activeId: null,
      messages: [],
      toolCards: [],
      approvals: [],
      streamingBuf: '',
      busy: false,
      error: null
    })
  },

  send: async (text) => {
    const { activeId, wxid, busy } = get()
    if (!activeId || busy) return
    const t = text.trim()
    if (!t) return
    set({ busy: true, streamingBuf: '', toolCards: [], approvals: [], error: null })
    const res = await wbApi?.send(activeId, wxid, t).catch(() => null)
    if (res && !res.ok) set({ busy: false, error: res.error ?? '发送失败' })
  },

  retry: async () => {
    const { activeId, wxid, busy } = get()
    if (!activeId || busy) return
    set({ busy: true, streamingBuf: '', toolCards: [], approvals: [], error: null })
    const res = await wbApi?.retry(activeId, wxid).catch(() => null)
    if (res && !res.ok) set({ busy: false, error: res.error ?? '重试失败' })
  },

  stop: async () => {
    const { activeId } = get()
    if (!activeId) return
    await wbApi?.stop(activeId).catch(() => null)
    set({ busy: false })
  },

  approve: async (runId, ok) => {
    await wbApi?.approve(runId, ok).catch(() => null)
    set({ approvals: get().approvals.filter((a) => a.runId !== runId) })
  }
}))

/** 事件接线(页面挂载时调用一次) */
export function subscribeWorkbenchEvents(): () => void {
  const off = wbApi?.onEvent?.((raw) => {
    const e = raw as {
      sessionId?: number
      type?: string
      token?: string
      text?: string
      tool?: string
      toolStatus?: string
      args?: string
      resultClip?: string
      runId?: string
      approvalText?: string
      messageId?: number
    }
    const { activeId } = useWorkbenchChatStore.getState()
    if (!activeId || e.sessionId !== activeId) return
    const st = useWorkbenchChatStore.getState()
    if (e.type === 'delta' && e.token) {
      useWorkbenchChatStore.setState({ streamingBuf: st.streamingBuf + e.token })
    } else if (e.type === 'done') {
      useWorkbenchChatStore.setState({ busy: false, streamingBuf: '' })
      void useWorkbenchChatStore.getState().load(activeId)
    } else if (e.type === 'error') {
      useWorkbenchChatStore.setState({ busy: false, streamingBuf: '', error: e.text ?? '出错了' })
      void useWorkbenchChatStore.getState().load(activeId)
    } else if (e.type === 'status' && e.text === '已停止') {
      useWorkbenchChatStore.setState({ busy: false, streamingBuf: '' })
      void useWorkbenchChatStore.getState().load(activeId)
    } else if (e.type === 'approval' && e.runId) {
      useWorkbenchChatStore.setState({
        approvals: [
          ...st.approvals.filter((a) => a.runId !== e.runId),
          { runId: e.runId, tool: e.tool ?? '', args: e.args, approvalText: e.approvalText }
        ]
      })
    } else if (e.type === 'tool' && e.tool) {
      const cards = st.toolCards
      if (e.toolStatus === 'start') {
        useWorkbenchChatStore.setState({
          toolCards: [
            ...cards,
            { id: `${e.tool}:${cards.length}`, name: e.tool, status: 'start', args: e.args }
          ]
        })
      } else {
        useWorkbenchChatStore.setState({
          toolCards: cards.map((c) =>
            c.name === e.tool && c.status === 'start'
              ? { ...c, status: e.toolStatus === 'fail' ? 'fail' : 'done', result: e.resultClip }
              : c
          )
        })
      }
    }
  })
  return off ?? ((): void => {})
}
