import { create } from 'zustand'
import type { ChatMsgItem, ChatSessionItem } from '../../../shared/types'
import { useWorkbenchStore } from './workbench'

/**
 * AI 工作台前端 store(事件通道 ai:wb;会话复用 chat 体系,busy 按会话维度)。
 * 流畅性设计:
 * - delta 事件按帧批量合并(zustand 每 token 一 set 会整页重渲染);
 * - 帧队列带轮次号:done/error 先到时清空缓冲,迟到帧被丢弃,杜绝「结尾幽灵框」;
 * - 事件订阅常驻(singleton):切页/切会话不断线,busy/回显不会卡死;
 * - 发送后乐观回显用户消息(pendingTexts 按会话),避免整轮结束才出现自己的消息,
 *   也避免多会话并行时回显互相串台;load 成功以落库数据消解回显(不会重复上屏);
 * - load 带请求序号,防止慢响应覆盖后选的会话。
 * 多会话并行:
 * - busy 按会话,后台会话继续跑,整轮结束不丢(重新选中即全量刷新);
 * - sessNew/sessErr 会话级徽标:后台完成/失败在会话列表可见;
 * - 后台完成且窗口未聚焦时桌面提醒,点击直达工作台。
 */

/**
 * 当前轮时间线块:一轮生成内按事件顺序展示的内容(与历史消息区分开)。
 * - text:正文段落;工具调用之间会自然分段(每段独立气泡,卡片按序插入段落之间)
 * - tool:工具调用(含参数/结果,状态实时更新),不再堆在消息流末尾
 * - reason:推理过程实时流(出现于文本/工具之前)
 * 整轮结束(done/error/停止)后清空,由 load 后的正式消息接续时间线。
 */
export interface WbTurnBlock {
  id: number
  kind: 'text' | 'tool' | 'reason'
  text?: string
  name?: string
  status?: 'start' | 'done' | 'fail'
  /** 工具调用参数(JSON,引擎已截断至 4k) */
  args?: string
  /** 工具结果(引擎已截断至 4k,展开查看) */
  output?: string
  outTrunc?: boolean
}

/** 单轮内块序号(单调递增,仅作 key) */
let blockSeq = 0

export interface WbApprovalCard {
  runId: string
  tool: string
  args?: string
  approvalText?: string
}

/** 剔除会干扰 markdown/布局的控制字符(保留 \t \n \r)与零宽字符 */
export function cleanStreamText(s: string): string {
  /* eslint-disable no-control-regex -- 有意清理模型输出中的控制字符 */
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
  /* eslint-enable no-control-regex */
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
  /** 当前轮时间线块(文本段落/工具调用/推理过程,按发生顺序) */
  turnBlocks: WbTurnBlock[]
  approvals: WbApprovalCard[]
  error: string | null
  /** 乐观回显(按会话):引擎已落库但列表尚未刷新,先上屏的用户消息 */
  pendingTexts: Record<number, string>
  /** 上下文压缩标记(按会话):历史被压缩摘要,本轮起展示在消息流顶部(内存态) */
  compactBySid: Record<number, string>
  /** 编辑重发:正在改写最近一轮提问的会话(null=无) */
  editingSid: number | null

  init: (wxid: string) => Promise<void>
  load: (id: number) => Promise<void>
  select: (id: number) => Promise<void>
  create: (title: string) => Promise<number | null>
  remove: (id: number) => Promise<void>
  rename: (id: number, title: string) => Promise<void>
  clear: (id: number) => Promise<void>
  send: (text: string) => Promise<void>
  /** 编辑后重发:改写最近一轮提问(本地裁剪+引擎 resend) */
  sendEdited: (text: string) => Promise<void>
  retry: () => Promise<void>
  stop: () => Promise<void>
  approve: (runId: string, ok: boolean) => Promise<void>
  /** 信任放行:登记(本轮/始终允许)并放行当前单次 */
  trustTool: (runId: string, tool: string, scope: 'session' | 'global') => Promise<void>
  resetActive: () => void
  /** 进入编辑态:裁掉最近一轮(问题+回答),返回原问题文本供输入框改写;不可编辑返回 null */
  beginEdit: () => string | null
  /** 取消编辑:恢复会话原始记录 */
  cancelEdit: () => void
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

function withoutKeyStr(rec: Record<number, string>, key: number): Record<number, string> {
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

/**
 * 轮次号(按会话):send/retry 递增。
 * 帧队列入队时记录轮次,flush 时轮次不匹配或 busy 已复位 → 丢弃。
 * 修复:done/error 收尾(清空缓冲+全量刷新)先于本帧 flush 时,旧 delta 尾巴
 * (常见为收尾表情的单独一帧)不再被追加成「幽灵气泡」。
 */
const turnSeq = new Map<number, number>()
function bumpTurn(sid: number): number {
  const next = (turnSeq.get(sid) ?? 0) + 1
  turnSeq.set(sid, next)
  return next
}

/** 把 token 追加进当前轮时间线:kind 相同且是末尾块则续写,否则另起一块 */
function appendTurnToken(kind: 'text' | 'reason', token: string): void {
  const st = useWorkbenchChatStore.getState()
  const blocks = st.turnBlocks
  const last = blocks.length > 0 ? blocks[blocks.length - 1] : undefined
  if (last && last.kind === kind) {
    blocks[blocks.length - 1] = { ...last, text: (last.text ?? '') + token }
  } else {
    blocks.push({ id: ++blockSeq, kind, text: token })
  }
  useWorkbenchChatStore.setState({ turnBlocks: blocks })
}

/** delta 按帧批量(单路活动会话展示;text=正文,reason=推理过程) */
let deltaQueue: Array<{ sid: number; kind: 'text' | 'reason'; seq: number; token: string }> = []
let flushHandle: number | null = null
function queueDelta(sid: number, kind: 'text' | 'reason', token: string): void {
  if (!token) return
  deltaQueue.push({ sid, kind, seq: turnSeq.get(sid) ?? 0, token: cleanStreamText(token) })
  if (flushHandle !== null) return
  const flush = (): void => {
    flushHandle = null
    const items = deltaQueue
    deltaQueue = []
    for (const it of items) {
      const st = useWorkbenchChatStore.getState()
      if (it.sid !== st.activeId) continue // 非活动会话的增量丢弃,done 后整轮刷新兜底
      if (!st.busyIds[it.sid]) continue // 已收尾:迟到帧丢弃(最终内容由 load 全量兜底)
      if ((turnSeq.get(it.sid) ?? 0) !== it.seq) continue // 跨轮次旧帧:丢弃
      if (it.kind === 'text') {
        const latest = useWorkbenchChatStore.getState()
        if (latest.pendingTexts[it.sid] !== undefined) {
          useWorkbenchChatStore.setState({
            pendingTexts: withoutKeyStr(latest.pendingTexts, it.sid)
          })
        }
      }
      appendTurnToken(it.kind, it.token)
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
  turnBlocks: [],
  approvals: [],
  error: null,
  pendingTexts: {},
  compactBySid: {},
  editingSid: null,

  init: async (wxid) => {
    const key = wxid || ''
    const prevKey = get().wxid
    if (prevKey === key) {
      // 页面重挂载(切走再切回):只刷新会话列表,不打断进行中的生成/徽标/回显状态
      const res = await wbApi?.listChats(key).catch(() => null)
      if (res?.ok && res.chats) {
        const chats = res.chats as ChatSessionItem[]
        const st = get()
        set({ chats })
        if (st.activeId === null && chats.length > 0) {
          await get().select(chats[0].id)
        } else if (st.activeId !== null && !chats.some((c) => c.id === st.activeId)) {
          // 当前会话已被删除:复位并回到最新会话
          get().resetActive()
          if (chats.length > 0) await get().select(chats[0].id)
        }
      }
      return
    }
    // 账号切换:全量重建(旧账号状态不再适用)
    turnSeq.clear()
    set({
      wxid: key,
      chats: null,
      activeId: null,
      messages: [],
      loading: false,
      turnBlocks: [],
      approvals: [],
      error: null,
      pendingTexts: {},
      compactBySid: {},
      editingSid: null,
      busyIds: {},
      sessNew: {},
      sessErr: {}
    })
    const res = await wbApi?.listChats(key).catch(() => null)
    if (res?.ok && res.chats) {
      const chats = res.chats as ChatSessionItem[]
      set({ chats })
      if (chats.length > 0) await get().select(chats[0].id)
    } else {
      set({ chats: [] })
    }
  },

  load: async (id) => {
    const seq = ++loadSeq
    const res = await wbApi?.messages(id).catch(() => null)
    if (seq !== loadSeq) return // 期间已切换到别的会话,丢弃过期响应
    if (res?.ok && res.messages) {
      const msgs = res.messages as ChatMsgItem[]
      set({ messages: msgs, loading: false })
      // 压缩标记已持久化为消息行:移除同会话的内存标记,避免双份展示
      if (msgs.some((m) => m.kind === 'compact')) {
        const stNow = useWorkbenchChatStore.getState()
        if (stNow.compactBySid[id] !== undefined) {
          const compactBySid = { ...stNow.compactBySid }
          delete compactBySid[id]
          useWorkbenchChatStore.setState({ compactBySid })
        }
      }
      // 回显消解:落库里已出现同内容的用户消息(引擎发送即落库),回显不再重复上屏
      const st = useWorkbenchChatStore.getState()
      const pending = st.pendingTexts[id]
      if (pending !== undefined) {
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === 'user') {
            if (msgs[i].content === pending) {
              useWorkbenchChatStore.setState({ pendingTexts: withoutKeyStr(st.pendingTexts, id) })
            }
            break
          }
        }
      }
    } else {
      set({ loading: false, error: (res as { error?: string } | null)?.error ?? '加载失败' })
    }
  },

  select: async (id) => {
    const prev = get().activeId
    set({
      activeId: id,
      turnBlocks: [],
      approvals: [],
      error: null,
      editingSid: null,
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
    turnSeq.delete(id)
    const busyIds = { ...get().busyIds }
    delete busyIds[id]
    const next = (get().chats ?? []).filter((c) => c.id !== id)
    const compactBySid = { ...get().compactBySid }
    delete compactBySid[id]
    set({
      chats: next,
      busyIds,
      sessNew: withoutKey(get().sessNew, id),
      sessErr: withoutKey(get().sessErr, id),
      pendingTexts: withoutKeyStr(get().pendingTexts, id),
      compactBySid,
      editingSid: get().editingSid === id ? null : get().editingSid
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
    turnSeq.clear()
    set({
      activeId: null,
      messages: [],
      turnBlocks: [],
      approvals: [],
      error: null,
      pendingTexts: {},
      compactBySid: {},
      editingSid: null
    })
  },

  send: async (text) => {
    const { activeId, wxid, busyIds } = get()
    if (!activeId || busyIds[activeId]) return
    const t = cleanStreamText(text.trim())
    if (!t) return
    const sid = activeId
    bumpTurn(sid)
    set({
      busyIds: { ...busyIds, [sid]: true },
      sessErr: withoutKey(get().sessErr, sid),
      turnBlocks: [],
      approvals: [],
      error: null,
      pendingTexts: { ...get().pendingTexts, [sid]: t }
    })
    // 首轮发送时顺手请求通知权限(后台完成桌面提醒用,拒绝则静默降级为列表徽标)
    if ('Notification' in window && Notification.permission === 'default') {
      void Notification.requestPermission().catch(() => undefined)
    }
    const res = await wbApi?.send(sid, wxid, t).catch(() => null)
    // 引擎整轮结束才 resolve;期间失败已由 error 事件处理。此处兜底:忙碌未被事件清除时按失败收尾
    if (res && !res.ok && get().busyIds[sid]) {
      set({
        busyIds: { ...get().busyIds, [sid]: false },
        error: res.error ?? '发送失败',
        pendingTexts: withoutKeyStr(get().pendingTexts, sid)
      })
      if (get().activeId === sid) void get().load(sid)
    }
  },

  /** 编辑后重发:改写最近一轮提问(引擎侧 pop 尾部 assistant+最后 user 后以新文本重发) */
  sendEdited: async (text) => {
    const { activeId, wxid, busyIds, editingSid } = get()
    if (!activeId || activeId !== editingSid || busyIds[activeId]) return
    const t = cleanStreamText(text.trim())
    if (!t) return
    const sid = activeId
    bumpTurn(sid)
    set({
      busyIds: { ...busyIds, [sid]: true },
      editingSid: null,
      sessErr: withoutKey(get().sessErr, sid),
      turnBlocks: [],
      approvals: [],
      error: null,
      pendingTexts: { ...get().pendingTexts, [sid]: t }
    })
    const res = await wbApi?.resend(sid, wxid, t).catch(() => null)
    if (res && !res.ok && get().busyIds[sid]) {
      set({
        busyIds: { ...get().busyIds, [sid]: false },
        error: res.error ?? '重发失败',
        pendingTexts: withoutKeyStr(get().pendingTexts, sid)
      })
      if (get().activeId === sid) void get().load(sid)
    }
  },

  /** 进入编辑态:裁掉本地最近一轮(问题与后续回答),返回原问题文本;条件不满足返回 null */
  beginEdit: () => {
    const sid = get().activeId
    if (sid === null || get().busyIds[sid] || get().editingSid !== null) return null
    const msgs = get().messages
    let last = -1
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') {
        last = i
        break
      }
    }
    if (last < 0) return null
    const text = msgs[last].content
    set({ messages: msgs.slice(0, last), editingSid: sid })
    return text
  },

  /** 取消编辑:复位编辑态并从服务端恢复会话记录 */
  cancelEdit: () => {
    const sid = get().editingSid
    if (sid === null) return
    set({ editingSid: null })
    if (get().activeId === sid) void get().load(sid)
  },

  retry: async () => {
    const { activeId, wxid, busyIds } = get()
    if (!activeId || busyIds[activeId]) return
    const sid = activeId
    bumpTurn(sid)
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
      turnBlocks: [],
      approvals: [],
      error: null,
      messages: keep >= 0 ? msgs.slice(0, keep + 1) : msgs,
      pendingTexts: withoutKeyStr(get().pendingTexts, sid)
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
          turnBlocks: [],
          pendingTexts: withoutKeyStr(st.pendingTexts, sid)
        })
        if (st.activeId === sid) void st.load(sid)
      }
    }, 2000)
  },

  approve: async (runId, ok) => {
    await wbApi?.approve(runId, ok).catch(() => null)
    set({ approvals: get().approvals.filter((a) => a.runId !== runId) })
  },

  /** 信任放行:登记(本轮/始终允许)后立即放行当前单次请求 */
  trustTool: async (runId, tool, scope) => {
    const sid = get().activeId
    if (sid !== null) await wbApi?.trustTool(sid, tool, scope).catch(() => null)
    if (runId) await wbApi?.approve(runId, true).catch(() => null)
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
    output?: string
    outTrunc?: boolean
    resultClip?: string
    runId?: string
    approvalText?: string
    messageId?: number
  }
  const sid = e.sessionId
  if (sid === undefined) return
  const st = useWorkbenchChatStore.getState()
  const isActive = st.activeId === sid
  /** 收尾:复位 busy/回显;活动会话直接整刷,后台会话打徽标(重新选中时全量刷新兜底) */
  const finishTurn = (isErr: boolean, isStop = false): void => {
    const cur = useWorkbenchChatStore.getState()
    useWorkbenchChatStore.setState({
      pendingTexts: withoutKeyStr(cur.pendingTexts, sid),
      busyIds: cur.busyIds[sid] ? { ...cur.busyIds, [sid]: false } : cur.busyIds
    })
    const latest = useWorkbenchChatStore.getState()
    if (latest.activeId === sid) {
      useWorkbenchChatStore.setState({
        turnBlocks: [],
        sessNew: withoutKey(latest.sessNew, sid),
        sessErr: withoutKey(latest.sessErr, sid)
      })
      void useWorkbenchChatStore.getState().load(sid)
    } else if (!isStop) {
      // 会话已不在当前账号列表(切账号后旧账号后台收尾):静默丢弃,不污染徽标/通知
      const chatsNow = useWorkbenchChatStore.getState().chats
      if (chatsNow !== null && !chatsNow.some((c) => c.id === sid)) return
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
  } else if (e.type === 'compaction' && isActive) {
    const cur = useWorkbenchChatStore.getState()
    useWorkbenchChatStore.setState({
      compactBySid: {
        ...cur.compactBySid,
        [sid]: e.text || '旧对话已自动压缩,仅保留最近一段。'
      }
    })
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
    const stNow = useWorkbenchChatStore.getState()
    if (e.toolStatus === 'start') {
      // 追加为时间线块:自动封口当前文本段,后续文本另起一段,保持发生顺序
      useWorkbenchChatStore.setState({
        turnBlocks: [
          ...stNow.turnBlocks,
          { id: ++blockSeq, kind: 'tool', name: e.tool, status: 'start', args: e.args }
        ]
      })
    } else {
      // 收尾最近的同名 start 块(参数/结果就位)
      const blocks = stNow.turnBlocks
      let doneIdx = -1
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i]
        if (b.kind === 'tool' && b.name === e.tool && b.status === 'start') {
          doneIdx = i
          break
        }
      }
      if (doneIdx >= 0) {
        const next = blocks.slice()
        next[doneIdx] = {
          ...next[doneIdx],
          status: e.toolStatus === 'fail' ? 'fail' : 'done',
          output: e.output ?? e.resultClip,
          outTrunc: e.toolStatus === 'fail' ? undefined : e.outTrunc
        }
        useWorkbenchChatStore.setState({ turnBlocks: next })
      }
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
