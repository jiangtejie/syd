import { create } from 'zustand'
import type { ChatMsgItem, ChatSessionItem } from '../../../shared/types'
import { useWorkbenchStore } from './workbench'

/**
 * AI 工作台前端 store(事件通道 ai:wb;会话复用 chat 体系,busy 按会话维度)。
 * 流畅性设计:
 * - delta 事件按帧批量合并(zustand 每 token 一 set 会整页重渲染);
 * - 事件订阅常驻(singleton):切页/切会话不断线,busy/回显不会卡死;
 * - 发送后乐观回显用户消息(pendingUser),避免整轮结束才出现自己的消息;
 * - load 带请求序号,防止慢响应覆盖后选的会话。
 * 多会话并行:
 * - busy 按会话,后台会话继续跑,整轮结束不丢(重新选中即全量刷新);
 * - sessNew/sessErr 会话级徽标:后台完成/失败在会话列表可见;
 * - 后台完成且窗口未聚焦时桌面提醒,点击直达工作台。
 */

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
  /** 每会话生成状态(切换会话不互相阻塞) */
  busyIds: Record<number, boolean>
  /** 后台完成未读徽标:该会话有新回复且尚未被查看 */
  sessNew: Record<number, boolean>
  /** 后台失败徽标 */
  sessErr: Record<number, boolean>
  streamingBuf: string
  /** 推理过程(思考内容)实时缓冲:reasoner 模型才出现 */
  reasoningBuf: string
  toolCards: WbToolCard[]
  approvals: WbApprovalCard[]
  error: string | null
  /** 乐观回显:引擎已落库但列表尚未刷新,先上屏的用户消息(仅当前轮) */
  pendingUser: { sid: number; text: string } | null

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

/** 删除记录项(不可变更新) */
function withoutKey<K extends string | number>(
  rec: Record<K, boolean>,
  key: K
): Record<K, boolean> {
  const next = { ...rec }
  delete next[key]
  return next
}

/** 后台完成且窗口未聚焦:桌面提醒,点击直达工作台 */
function notifyDone(sid: number): void {
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  if (document.hasFocus()) return
  const chats = useWorkbenchChatStore.getState().chats ?? []
  const title = chats.find((c) => c.id === sid)?.title ?? '工作台会话'
  try {
    const n = new Notification('AI 工作台', { body: `「${title}」已完成本轮回复，点击查看` })
    n.onclick = (): void => {
      useWorkbenchStore.getState().setPage('workbench')
      window.focus()
    }
  } catch {
    /* 忽略通知不可用 */
  }
}

/** load 请求序号:慢响应不得覆盖后选的会话 */
let loadSeq = 0

/** delta 按帧批量(单路活动会话展示;text=正文,reason=推理过程) */
let deltaQueue: Array<{ sid: number; kind: 'text' | 'reason'; token: string }> = []
let flushHandle: number | null = null
function queueDelta(sid: number, kind: 'text' | 'reason', token: string): void {
  deltaQueue.push({ sid, kind, token })
  if (flushHandle !== null) return
  const flush = (): void => {
    flushHandle = null
    const items = deltaQueue
    deltaQueue = []
    for (const it of items) {
      const st = useWorkbenchChatStore.getState()
      if (it.sid !== st.activeId) continue // 非活动会话的增量先丢弃,done 后整轮刷新兜底
      if (it.kind === 'text') {
        if (st.pendingUser?.sid === it.sid) useWorkbenchChatStore.setState({ pendingUser: null })
        useWorkbenchChatStore.setState({
          streamingBuf: st.streamingBuf + it.token
        })
      } else {
        useWorkbenchChatStore.setState({
          reasoningBuf: st.reasoningBuf + it.token
        })
      }
    }
  }
  flushHandle =
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(flush)
      : (setTimeout(flush, 32) as unknown as number)
}

export const useWorkbenchChatStore = create<WbState>((set, get) => ({
  wxid: '',
  chats: null,
  activeId: null,
  messages: [],
  loading: false,
  busyIds: {},
  sessNew: {},
  sessErr: {},
  streamingBuf: '',
  reasoningBuf: '',
  toolCards: [],
  approvals: [],
  error: null,
  pendingUser: null,

  init: async (wxid) => {
    const key = wxid || ''
    set({
      wxid: key,
      streamingBuf: '',
      reasoningBuf: '',
      toolCards: [],
      approvals: [],
      error: null,
      pendingUser: null,
      busyIds: {},
      sessNew: {},
      sessErr: {}
    })
    const res = await wbApi?.listChats(key).catch(() => null)
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
    const seq = ++loadSeq
    const res = await wbApi?.messages(id).catch(() => null)
    if (seq !== loadSeq) return // 期间已切换到别的会话,丢弃过期响应
    if (res?.ok && res.messages) {
      set({ messages: res.messages as ChatMsgItem[], loading: false })
    } else {
      set({ loading: false, error: (res as { error?: string } | null)?.error ?? '加载失败' })
    }
  },

  select: async (id) => {
    const prev = get().activeId
    set({
      activeId: id,
      toolCards: [],
      approvals: [],
      streamingBuf: '',
      reasoningBuf: '',
      error: null,
      sessNew: withoutKey(get().sessNew, id),
      sessErr: withoutKey(get().sessErr, id)
    })
    if (prev !== id) set({ messages: [], loading: true })
    await get().load(id)
  },

  create: async (title) => {
    const res = await wbApi?.create(get().wxid, title).catch(() => null)
    if (!res?.ok || res.id === undefined) return null
    const now = Date.now()
    const session: ChatSessionItem = {
      id: res.id,
      wxid: `wb:${get().wxid}`,
      title: title.trim() || '工作台会话',
      createdAt: now,
      updatedAt: now
    }
    set({ chats: [session, ...(get().chats ?? [])] })
    await get().select(res.id)
    return res.id
  },

  remove: async (id) => {
    const res = await wbApi?.remove(id).catch(() => null)
    if (!res?.ok) return
    const busyIds = { ...get().busyIds }
    delete busyIds[id]
    const next = (get().chats ?? []).filter((c) => c.id !== id)
    set({
      chats: next,
      busyIds,
      sessNew: withoutKey(get().sessNew, id),
      sessErr: withoutKey(get().sessErr, id),
      pendingUser: get().pendingUser?.sid === id ? null : get().pendingUser
    })
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
      reasoningBuf: '',
      error: null,
      pendingUser: null
    })
  },

  send: async (text) => {
    const { activeId, wxid, busyIds } = get()
    if (!activeId || busyIds[activeId]) return
    const t = text.trim()
    if (!t) return
    const sid = activeId
    set({
      busyIds: { ...busyIds, [sid]: true },
      sessErr: withoutKey(get().sessErr, sid),
      streamingBuf: '',
      reasoningBuf: '',
      toolCards: [],
      approvals: [],
      error: null,
      pendingUser: { sid, text: t }
    })
    const res = await wbApi?.send(sid, wxid, t).catch(() => null)
    // 首轮发送时顺手请求通知权限(后台完成桌面提醒用,拒绝则静默降级为列表徽标)
    if ('Notification' in window && Notification.permission === 'default') {
      void Notification.requestPermission().catch(() => undefined)
    }
    // 引擎整轮结束才 resolve;期间失败已由 error 事件处理。此处兜底:忙碌未被事件清除时按失败收尾
    if (res && !res.ok && get().busyIds[sid]) {
      set({
        busyIds: { ...get().busyIds, [sid]: false },
        error: res.error ?? '发送失败',
        pendingUser: get().pendingUser?.sid === sid ? null : get().pendingUser
      })
      if (get().activeId === sid) void get().load(sid)
    }
  },

  retry: async () => {
    const { activeId, wxid, busyIds } = get()
    if (!activeId || busyIds[activeId]) return
    const sid = activeId
    // 引擎重试前会弹出尾部 assistant 行:先同步裁剪本地列表,避免旧气泡残留
    const msgs = get().messages
    let keep = -1
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') {
        keep = i
        break
      }
    }
    set({
      busyIds: { ...busyIds, [sid]: true },
      sessErr: withoutKey(get().sessErr, sid),
      streamingBuf: '',
      reasoningBuf: '',
      toolCards: [],
      approvals: [],
      error: null,
      messages: keep >= 0 ? msgs.slice(0, keep + 1) : msgs,
      pendingUser: get().pendingUser?.sid === sid ? null : get().pendingUser
    })
    const res = await wbApi?.retry(sid, wxid).catch(() => null)
    if (res && !res.ok && get().busyIds[sid]) {
      set({
        busyIds: { ...get().busyIds, [sid]: false },
        error: res.error ?? '重试失败'
      })
      if (get().activeId === sid) void get().load(sid)
    }
  },

  stop: async () => {
    const { activeId } = get()
    if (!activeId) return
    await wbApi?.stop(activeId).catch(() => null)
    // busy 由事件「已停止」复位;若事件丢失,此处不强行复位(避免与引擎仍运行冲突),
    // 轮询性兜底:2s 后仍未收到事件再复位
    const sid = activeId
    window.setTimeout(() => {
      const st = useWorkbenchChatStore.getState()
      if (st.busyIds[sid]) {
        useWorkbenchChatStore.setState({
          busyIds: { ...st.busyIds, [sid]: false },
          streamingBuf: '',
          reasoningBuf: '',
          pendingUser: st.pendingUser?.sid === sid ? null : st.pendingUser
        })
        if (st.activeId === sid) void st.load(sid)
      }
    }, 2000)
  },

  approve: async (runId, ok) => {
    await wbApi?.approve(runId, ok).catch(() => null)
    set({ approvals: get().approvals.filter((a) => a.runId !== runId) })
  }
}))

/** 事件回调(单实例):按会话复位 busy/回显;活动会话才更新屏幕内容 */
function handleWbEvent(raw: unknown): void {
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
  const sid = e.sessionId
  if (sid === undefined) return
  const st = useWorkbenchChatStore.getState()
  const isActive = st.activeId === sid
  const clearPending = (): void => {
    const cur = useWorkbenchChatStore.getState().pendingUser
    if (cur?.sid === sid) useWorkbenchChatStore.setState({ pendingUser: null })
  }
  /** 收尾:复位 busy/回显;活动会话直接整刷,后台会话打徽标(重新选中时全量刷新兜底) */
  const finishTurn = (isErr: boolean, isStop = false): void => {
    clearPending()
    const cur = useWorkbenchChatStore.getState()
    if (cur.busyIds[sid]) {
      useWorkbenchChatStore.setState({ busyIds: { ...cur.busyIds, [sid]: false } })
    }
    const latest = useWorkbenchChatStore.getState()
    if (latest.activeId === sid) {
      useWorkbenchChatStore.setState({
        streamingBuf: '',
        reasoningBuf: '',
        sessNew: withoutKey(latest.sessNew, sid),
        sessErr: withoutKey(latest.sessErr, sid)
      })
      void useWorkbenchChatStore.getState().load(sid)
    } else if (!isStop) {
      const now = useWorkbenchChatStore.getState()
      useWorkbenchChatStore.setState({
        sessNew: { ...now.sessNew, [sid]: true },
        sessErr: isErr ? { ...now.sessErr, [sid]: true } : withoutKey(now.sessErr, sid)
      })
      if (!isErr) notifyDone(sid)
    }
  }
  if (e.type === 'delta' && e.token && isActive) {
    queueDelta(sid, 'text', e.token)
  } else if (e.type === 'reasoning' && e.token && isActive) {
    queueDelta(sid, 'reason', e.token)
  } else if (e.type === 'done') {
    finishTurn(false)
  } else if (e.type === 'error') {
    finishTurn(true)
    if (isActive) {
      useWorkbenchChatStore.setState({ error: e.text ?? '出错了' })
    }
  } else if (e.type === 'status' && e.text === '已停止') {
    finishTurn(false, true)
  } else if (e.type === 'approval' && e.runId && isActive) {
    useWorkbenchChatStore.setState({
      approvals: [
        ...useWorkbenchChatStore.getState().approvals.filter((a) => a.runId !== e.runId),
        { runId: e.runId, tool: e.tool ?? '', args: e.args, approvalText: e.approvalText }
      ]
    })
  } else if (e.type === 'tool' && e.tool && isActive) {
    const cards = useWorkbenchChatStore.getState().toolCards
    if (e.toolStatus === 'start') {
      useWorkbenchChatStore.setState({
        toolCards: [
          ...cards,
          { id: `${e.tool}:${Date.now()}`, name: e.tool, status: 'start', args: e.args }
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
}

let eventsBound = false
/** 事件订阅常驻:页面挂载一次后不随切页摘除,避免 busy/回显状态卡死 */
export function ensureWorkbenchEvents(): void {
  if (eventsBound) return
  eventsBound = true
  wbApi?.onEvent?.(handleWbEvent)
}

/** 兼容旧调用(页面卸载不再摘除) */
export function subscribeWorkbenchEvents(): () => void {
  ensureWorkbenchEvents()
  return (): void => {}
}
