import { create } from 'zustand'
import type { ChatMsgItem, WorkspaceSessionItem } from '../../../shared/types'

/** 工作区 Agent(本地自动化副驾)前端 store;事件通道 ai:ws。 */

export interface WsToolCard {
  id: string
  name: string
  status: 'start' | 'pending' | 'done' | 'fail'
  args?: string
  result?: string
  runId?: string
}

interface WorkspaceState {
  sessions: WorkspaceSessionItem[] | null
  activeId: number | null
  messages: ChatMsgItem[]
  loading: boolean
  busy: boolean
  streamingBuf: string
  toolCards: WsToolCard[]
  error: string | null

  init: () => Promise<void>
  select: (id: number) => Promise<void>
  /** 无条件重拉某会话消息(done/错误后刷新用) */
  load: (id: number) => Promise<void>
  create: (cwd: string, title: string) => Promise<number | null>
  remove: (id: number) => Promise<void>
  rename: (id: number, title: string) => Promise<void>
  send: (text: string) => Promise<void>
  retry: () => Promise<void>
  stop: () => Promise<void>
  confirm: (runId: string, ok: boolean) => Promise<void>
  resetActive: () => void
}

const wsApi = window.api?.cs?.ws

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  sessions: null,
  activeId: null,
  messages: [],
  loading: false,
  busy: false,
  streamingBuf: '',
  toolCards: [],
  error: null,

  init: async () => {
    const res = await wsApi?.list().catch(() => null)
    if (res?.ok && res.sessions) {
      set({ sessions: res.sessions as WorkspaceSessionItem[] })
      if (get().activeId === null && (res.sessions as WorkspaceSessionItem[]).length > 0) {
        await get().select((res.sessions as WorkspaceSessionItem[])[0].id)
      }
    } else {
      set({ sessions: [] })
    }
  },

  select: async (id) => {
    const prev = get().activeId
    set({ activeId: id, toolCards: [], streamingBuf: '', error: null })
    if (prev !== id) set({ messages: [], loading: true })
    await get().load(id)
  },

  load: async (id) => {
    const res = await wsApi?.messages(id).catch(() => null)
    if (res?.ok && res.messages) {
      set({ messages: res.messages as ChatMsgItem[], loading: false })
    } else {
      set({ loading: false, error: (res as { error?: string } | null)?.error ?? '加载失败' })
    }
  },

  create: async (cwd, title) => {
    const res = await wsApi?.create(cwd, title).catch(() => null)
    if (!res?.ok || res.id === undefined) return null
    const sessions = await wsApi?.list().catch(() => null)
    if (sessions?.ok && sessions.sessions) {
      set({ sessions: sessions.sessions as WorkspaceSessionItem[] })
    }
    void get().select(res.id)
    return res.id
  },

  remove: async (id) => {
    const res = await wsApi?.remove(id).catch(() => null)
    if (!res?.ok) return
    const next = (get().sessions ?? []).filter((s) => s.id !== id)
    set({ sessions: next })
    if (get().activeId === id) {
      if (next.length > 0) void get().select(next[0].id)
      else get().resetActive()
    }
  },

  rename: async (id, title) => {
    const res = await wsApi?.rename(id, title).catch(() => null)
    if (!res?.ok) return
    set({
      sessions: (get().sessions ?? []).map((s) => (s.id === id ? { ...s, title } : s))
    })
  },

  resetActive: () => {
    set({ activeId: null, messages: [], toolCards: [], streamingBuf: '', busy: false, error: null })
  },

  send: async (text) => {
    const { activeId } = get()
    if (!activeId || get().busy) return
    const t = text.trim()
    if (!t) return
    set({ busy: true, streamingBuf: '', toolCards: [], error: null })
    const res = await wsApi?.send(activeId, t).catch(() => null)
    if (res && !res.ok) {
      set({ busy: false, error: res.error ?? '发送失败' })
    }
  },

  retry: async () => {
    const { activeId } = get()
    if (!activeId || get().busy) return
    set({ busy: true, streamingBuf: '', toolCards: [], error: null })
    const res = await wsApi?.retry(activeId).catch(() => null)
    if (res && !res.ok) set({ busy: false, error: res.error ?? '重试失败' })
  },

  stop: async () => {
    const { activeId } = get()
    if (!activeId) return
    await wsApi?.stop(activeId).catch(() => null)
    set({ busy: false })
  },

  confirm: async (runId, ok) => {
    await wsApi?.confirm(runId, ok).catch(() => null)
    set({
      toolCards: get().toolCards.filter((c) => c.runId !== runId)
    })
  }
}))

// 事件接线(挂载时由页面调用一次)
export function subscribeWorkspaceEvents(): () => void {
  const off = wsApi?.onEvent?.((evt) => {
    const e = evt as {
      sessionId?: number
      type?: string
      token?: string
      text?: string
      chatId?: number
      tool?: string
      toolStatus?: string
      args?: string
      resultClip?: string
      messageId?: number
    }
    const { activeId } = useWorkspaceStore.getState()
    if (!activeId || e.sessionId !== activeId) return
    const st = useWorkspaceStore.getState()
    if (e.type === 'delta' && e.token) {
      useWorkspaceStore.setState({ streamingBuf: st.streamingBuf + e.token })
    } else if (e.type === 'done') {
      useWorkspaceStore.setState({ busy: false, streamingBuf: '' })
      void useWorkspaceStore.getState().load(activeId) // 重拉消息(含落库正文)
    } else if (e.type === 'error') {
      useWorkspaceStore.setState({ busy: false, streamingBuf: '', error: e.text ?? '出错了' })
      void useWorkspaceStore.getState().load(activeId)
    } else if (e.type === 'status' && e.text === '已停止') {
      useWorkspaceStore.setState({ busy: false, streamingBuf: '' })
      void useWorkspaceStore.getState().load(activeId)
    } else if (e.type === 'tool' && e.tool) {
      const cards = useWorkspaceStore.getState().toolCards
      const id = `${e.sessionId}:${e.tool}:${cards.length}`
      if (e.toolStatus === 'start' || e.toolStatus === 'pending') {
        useWorkspaceStore.setState({
          toolCards: [
            ...cards,
            {
              id,
              name: e.tool,
              status: e.toolStatus === 'pending' ? 'pending' : 'start',
              args: e.args,
              runId: e.text
            }
          ]
        })
      } else {
        useWorkspaceStore.setState({
          toolCards: cards.map((c) =>
            c.name === e.tool && c.status !== 'done' && c.status !== 'fail'
              ? { ...c, status: e.toolStatus === 'fail' ? 'fail' : 'done', result: e.resultClip }
              : c
          )
        })
      }
    }
  })
  return off ?? ((): void => {})
}
