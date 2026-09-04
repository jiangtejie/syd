import { memo, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatMsgItem } from '../../../shared/types'
import {
  cleanStreamText,
  ensureWorkbenchEvents,
  useWorkbenchChatStore,
  type WbToolCard
} from '../stores/workbenchChat'
import { useWorkbenchStore } from '../stores/workbench'
import { toast } from '../stores/toast'
import './workbench-chat.css'

/**
 * AI 工作台页:让 AI 调用产品原生能力(业务查询/软件状态)+ SKILL.md 业务口径。
 * 引擎基于 Vercel AI SDK(主进程),工具只读;写/危险操作会经确认桥弹窗(v2 启用)。
 * 交互优化:历史气泡 memo(流式时不重复解析 Markdown)、delta 按帧渲染(带轮次防幽灵帧)、
 * 发送后乐观回显、跟随滚动(用户上翻时不抢滚)、思考动画、中文输入法回车不误发、
 * reasoner 推理过程实时流+落库可折叠回看、超长会话消息窗口化。
 * 回复渲染稳健性:控制字符清洗、链接外部打开、图片限高加载失败隐藏、表格横向滚动。
 */

/** 消息窗口:只渲染最近 N 条(超长会话防整表重排);向上分页翻更早 */
const WB_WINDOW = 200
const WB_OLDER_STEP = 200

/** 链接:应用内页面不可被模型输出导航走(主进程对 window.open 统一走系统浏览器) */
function MdLink(props: React.AnchorHTMLAttributes<HTMLAnchorElement>): React.JSX.Element {
  const { href, children, ...rest } = props
  return (
    <a {...rest} href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  )
}

/** 图片:限高防撑爆气泡;加载失败就地隐藏(不显示裂图) */
function MdImg(props: React.ImgHTMLAttributes<HTMLImageElement>): React.JSX.Element | null {
  const [failed, setFailed] = useState(false)
  const src = props.src
  // 流式中图片 URL 是逐步成型的:URL 变化时复位失败态,避免残缺 URL 404 后永久隐藏
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 源变化复位失败标记(全仓同款模式)
    setFailed(false)
  }, [src])
  if (failed || !src) return null
  return (
    <img
      {...props}
      alt={props.alt ?? ''}
      referrerPolicy="no-referrer"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  )
}

/** 固定组件映射(模块级稳定引用):最终消息与流式缓冲共用同一套渲染语义 */
const MD_COMPONENTS = {
  a: MdLink,
  img: MdImg
}

function WbMessageInner({ msg }: { msg: ChatMsgItem }): React.JSX.Element {
  const isUser = msg.role === 'user'
  const isError = msg.kind === 'error'
  const [reasonOpen, setReasonOpen] = useState(false)
  const content = useMemo(() => cleanStreamText(msg.content), [msg.content])
  const meta = useMemo(() => {
    if (!msg.meta) return null
    try {
      const p = JSON.parse(msg.meta) as unknown
      return p && typeof p === 'object' ? (p as Record<string, unknown>) : null
    } catch {
      return null
    }
  }, [msg.meta])
  const reasoningText =
    !isUser && !isError && typeof meta?.reasoning === 'string' ? meta.reasoning : ''
  const t = meta?.tokens as { input?: number; output?: number } | undefined
  const hasTokens = !!t && (typeof t.input === 'number' || typeof t.output === 'number')
  return (
    <div className={`wb-row${isUser ? ' is-user' : ''}${isError ? ' is-error' : ''}`}>
      <div className="wb-bubble">
        {isError ? (
          <span className="wb-error-text">{content}</span>
        ) : isUser ? (
          <div className="wb-plain">{content}</div>
        ) : (
          <>
            {reasoningText && (
              <div className="wb-reason">
                <button
                  type="button"
                  className="wb-reason-toggle"
                  aria-expanded={reasonOpen}
                  onClick={() => setReasonOpen((o) => !o)}
                >
                  <span className={`wb-reason-caret${reasonOpen ? ' is-open' : ''}`}>▸</span>
                  思考过程 · {reasoningText.length} 字
                </button>
                {reasonOpen && <pre className="wb-reason-static">{reasoningText}</pre>}
              </div>
            )}
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
              {content}
            </ReactMarkdown>
            {hasTokens && (
              <div className="wb-tokens-line">
                {typeof t.input === 'number' ? `输入 ${t.input}` : ''}
                {typeof t.input === 'number' && typeof t.output === 'number' ? ' / ' : ''}
                {typeof t.output === 'number' ? `输出 ${t.output}` : ''} tokens
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/** memo:流式期间历史消息不重渲染(ReactMarkdown 解析开销大) */
const WbMessage = memo(WbMessageInner, (prev, next) => {
  const a = prev.msg
  const b = next.msg
  return a.id === b.id && a.role === b.role && a.kind === b.kind && a.content === b.content
})

function WbToolCards(): React.JSX.Element | null {
  const cards = useWorkbenchChatStore((s) => s.toolCards)
  if (cards.length === 0) return null
  return (
    <div className="wb-toolcards">
      {cards.map((c) => (
        <WbToolCard key={c.id} c={c} />
      ))}
    </div>
  )
}

function WbToolCard({ c }: { c: WbToolCard }): React.JSX.Element {
  return (
    <div className={`wb-toolcard is-${c.status}`}>
      <span className="wb-toolcard-name">
        {c.status === 'start' && '⚙ '}
        {c.status === 'done' && '✓ '}
        {c.status === 'fail' && '✗ '}
        {c.name}
      </span>
      {c.args && <code className="wb-toolcard-args">{c.args}</code>}
      {c.result && <div className="wb-toolcard-result">{c.result}</div>}
    </div>
  )
}

function WbApprovals(): React.JSX.Element | null {
  const approvals = useWorkbenchChatStore((s) => s.approvals)
  const approve = useWorkbenchChatStore((s) => s.approve)
  if (approvals.length === 0) return null
  return (
    <div className="wb-approvals">
      <div className="wb-approvals-tip">此操作需要你确认后才继续执行</div>
      {approvals.map((a) => (
        <div key={a.runId} className="wb-approval">
          <div className="wb-approval-title">请求执行工具:{a.tool}</div>
          {a.args && <code className="wb-toolcard-args">{a.args}</code>}
          <div className="wb-approval-ops">
            <button type="button" className="st-btn sm" onClick={() => void approve(a.runId, true)}>
              允许执行
            </button>
            <button
              type="button"
              className="st-btn ghost sm"
              onClick={() => void approve(a.runId, false)}
            >
              拒绝
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

export default function WorkbenchChatPage(): React.JSX.Element {
  const wxid = useWorkbenchStore((s) => s.wxid)
  const connected = !!wxid && wxid !== 'wxid_demo'
  const [draft, setDraft] = useState('')
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const store = useWorkbenchChatStore()
  const { chats, activeId, messages, loading, busyIds, streamingBuf, error, pendingTexts } = store
  const pendingText = activeId !== null ? (pendingTexts[activeId] ?? undefined) : undefined
  const toolCards = useWorkbenchChatStore((s) => s.toolCards)
  const approvals = useWorkbenchChatStore((s) => s.approvals)
  const reasoningBuf = useWorkbenchChatStore((s) => s.reasoningBuf)
  const sessNew = useWorkbenchChatStore((s) => s.sessNew)
  const sessErr = useWorkbenchChatStore((s) => s.sessErr)
  const activeBusy = activeId !== null && !!busyIds[activeId]
  const [stick, setStick] = useState(true)
  const stickRef = useRef(true)

  /** 消息窗口化:只渲染最近 WB_WINDOW 条,防止超长会话整表重排;向上可翻更早 */
  // lazy 初始化:切页再回来时组件状态重置,首帧即按当前消息数截尾,避免先全量渲染再校正
  const [startIdx, setStartIdx] = useState(() => Math.max(0, messages.length - WB_WINDOW))
  const pendingAnchorRef = useRef<string | null>(null)
  const visible = useMemo(
    () => (startIdx > 0 ? messages.slice(startIdx) : messages),
    [messages, startIdx]
  )
  // 底部跟随:整轮加载/追加后,窗口保持贴底(仅用户本就在底部时)
  useEffect(() => {
    if (!stickRef.current) return
    const maxStart = Math.max(0, messages.length - WB_WINDOW)
    setStartIdx((i) => (i === maxStart ? i : maxStart))
  }, [messages])
  // 加载更早:以原首条为锚,展开后仍停在原位附近
  useEffect(() => {
    const id = pendingAnchorRef.current
    if (id === null) return
    pendingAnchorRef.current = null
    const el = bodyRef.current?.querySelector(`[data-wid="${id}"]`)
    el?.scrollIntoView({ block: 'start' })
  }, [startIdx])

  /** 应用内输入弹窗（Electron 不支持 window.prompt：不弹窗且返回 undefined） */
  interface PromptState {
    title: string
    initial: string
    placeholder: string
    okLabel: string
    submit: (value: string) => void | Promise<void>
  }
  const [promptState, setPromptState] = useState<PromptState | null>(null)
  const [promptVal, setPromptVal] = useState('')
  const [promptBusy, setPromptBusy] = useState(false)

  const openPrompt = (cfg: PromptState): void => {
    setPromptVal(cfg.initial)
    setPromptState(cfg)
  }
  const closePrompt = (): void => {
    if (promptBusy) return
    setPromptState(null)
  }
  const submitPrompt = async (): Promise<void> => {
    if (!promptState || promptBusy) return
    const v = promptVal.trim()
    if (!v) return
    setPromptBusy(true)
    try {
      await promptState.submit(v)
      setPromptState(null)
    } finally {
      setPromptBusy(false)
    }
  }

  const accountKey = connected ? wxid : ''
  useEffect(() => {
    void store.init(accountKey)
    ensureWorkbenchEvents()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 账号切换时重建工作台会话(全仓同款模式)
  }, [accountKey])

  // 切会话:先滚到底并进入「跟随」态(消息异步加载,加载完成后由下方 effect 再滚一次)
  useEffect(() => {
    stickRef.current = true
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 会话切换时同步复位跟随态(全仓同款模式)
    setStick(true)
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [activeId])

  // 内容更新(流式/推理/回显/工具卡/整轮刷新/窗口变化):仅在用户处于底部附近时跟随滚动
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    if (stickRef.current) el.scrollTop = el.scrollHeight
  }, [messages, streamingBuf, reasoningBuf, pendingText, toolCards, approvals, loading, startIdx])

  const handleBodyScroll = (): void => {
    const el = bodyRef.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 90
    if (near !== stickRef.current) {
      stickRef.current = near
      setStick(near)
    }
  }

  const jumpToBottom = (): void => {
    stickRef.current = true
    setStick(true)
    pendingAnchorRef.current = null
    setStartIdx(Math.max(0, messages.length - WB_WINDOW))
  }

  /** 加载更早:记录原首条,展开后以它为锚保持位置(进入历史浏览态,停止跟随) */
  const loadOlder = (): void => {
    const anchorId = messages[startIdx]?.id
    if (anchorId === undefined) return
    pendingAnchorRef.current = String(anchorId)
    stickRef.current = false
    setStick(false)
    setStartIdx((i) => Math.max(0, i - WB_OLDER_STEP))
  }

  const active = useMemo(
    () => (chats ?? []).find((c) => c.id === activeId) ?? null,
    [chats, activeId]
  )

  const createChat = (): void => {
    openPrompt({
      title: '新建工作台会话',
      placeholder: '输入会话名称',
      okLabel: '创建',
      initial: `会话 ${(chats?.length ?? 0) + 1}`,
      submit: async (value) => {
        const id = await store.create(value.trim())
        if (id === null) {
          toast.error('新建会话失败,请重启应用后重试')
        }
      }
    })
  }

  const canSend = !!activeId && !activeBusy
  const send = (): void => {
    const t = draft.trim()
    if (!t || !canSend) return
    setDraft('')
    stickRef.current = true
    setStick(true)
    // 若用户正在翻更早历史,发送后回到贴底窗口
    setStartIdx(Math.max(0, messages.length - WB_WINDOW))
    void store.send(t)
    // 按钮点击路径恢复输入焦点(回车路径焦点本就在输入框)
    requestAnimationFrame(() => taRef.current?.focus())
  }

  /** 输入框随内容自动增高(上限 220px,由 CSS max-height 兜底) */
  const growTextarea = (): void => {
    const el = taRef.current
    if (!el) return
    if (!el.value) {
      el.style.height = ''
      return
    }
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }

  return (
    <div className="wb-page">
      <aside className="wb-side">
        <button type="button" className="st-btn wb-new" onClick={createChat}>
          ＋ 新会话
        </button>
        <div className="wb-side-tip">
          {connected
            ? '已绑定账号:业务查询与软件能力均可用。'
            : '未绑定账号:仅软件状态可用,业务查询会提示先连接。'}
        </div>
        <div className="wb-side-list">
          {chats === null && <div className="wb-empty">加载中…</div>}
          {chats !== null && chats.length === 0 && (
            <div className="wb-empty">还没有会话。新建后即可让 AI 查数据、给口径、写总结。</div>
          )}
          {(chats ?? []).map((c) => (
            <div
              key={c.id}
              className={`wb-side-item${activeId === c.id ? ' is-active' : ''}`}
              onClick={() => void store.select(c.id)}
            >
              <div className="wb-side-main">
                <div className="wb-side-title">{c.title}</div>
                {c.id !== activeId && (busyIds[c.id] || sessNew[c.id] || sessErr[c.id]) && (
                  <div className="wb-side-status">
                    {busyIds[c.id] && (
                      <span className="wb-side-run">
                        <i className="wb-side-run-dot" />
                        生成中
                      </span>
                    )}
                    {!busyIds[c.id] && sessNew[c.id] && <span className="wb-side-new">新回复</span>}
                    {sessErr[c.id] && <span className="wb-side-err">失败</span>}
                  </div>
                )}
              </div>
              <div className="wb-side-ops">
                <button
                  type="button"
                  title="重命名"
                  onClick={(e) => {
                    e.stopPropagation()
                    openPrompt({
                      title: '重命名会话',
                      placeholder: '输入新名称',
                      okLabel: '保存',
                      initial: c.title,
                      submit: (t) => store.rename(c.id, t.trim())
                    })
                  }}
                >
                  改
                </button>
                <button
                  type="button"
                  title="删除会话"
                  onClick={(e) => {
                    e.stopPropagation()
                    if (window.confirm(`删除会话「${c.title}」?`)) void store.remove(c.id)
                  }}
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      </aside>

      <div className="wb-main">
        <div className="wb-head">
          <div className="wb-head-title">
            <b>{active?.title ?? '工作台'}</b>
            <span className="wb-head-sub">AI 工作台 · 调用产品能力</span>
          </div>
          <div className="wb-head-right">
            <button
              type="button"
              className="st-btn ghost sm"
              disabled={!activeId || messages.length === 0 || activeBusy}
              onClick={() => void store.retry()}
            >
              重试
            </button>
            <button
              type="button"
              className="st-btn ghost sm"
              disabled={!activeId}
              onClick={() => void store.stop()}
            >
              停止
            </button>
            <button
              type="button"
              className="st-btn ghost danger sm"
              disabled={!activeId || messages.length === 0 || activeBusy}
              onClick={() => {
                if (window.confirm('清空当前会话的消息记录?')) void store.clear(activeId!)
              }}
            >
              清空
            </button>
          </div>
        </div>

        <div className="wb-body" ref={bodyRef} onScroll={handleBodyScroll}>
          {!activeId && (
            <div className="wb-welcome">
              <div className="wb-welcome-title">AI 工作台</div>
              <div className="wb-welcome-sub">
                基于标准 agent 引擎,直接调用产品能力:问问题、查监控、看客户、算统计。
                写操作类能力(后续开放)会先请求你确认。
              </div>
            </div>
          )}
          {loading && <div className="wb-loading">加载中…</div>}
          {!loading && startIdx > 0 && (
            <button type="button" className="wb-older" onClick={loadOlder}>
              ↑ 查看更早 {startIdx} 条
            </button>
          )}
          {!loading &&
            activeId !== null &&
            visible.map((m) => (
              <div className="wb-msg-anchor" data-wid={m.id} key={m.id}>
                <WbMessage msg={m} />
              </div>
            ))}
          {/* 乐观回显:本轮用户消息(引擎已落库,整轮结束刷新后被正式列表替换) */}
          {pendingText !== undefined && (
            <div className="wb-row is-user">
              <div className="wb-bubble">
                <div className="wb-plain">{pendingText}</div>
              </div>
            </div>
          )}
          {activeId !== null && !loading && messages.length === 0 && !activeBusy && (
            <div className="wb-loading">
              可以试试:「今天有哪些待处理问题?」「XX 客户最近聊了什么?」「导出范围有多大?」
            </div>
          )}
          <WbToolCards />
          <WbApprovals />
          {/* 等待首字:思考动画(推理流已开始或有审批卡片时不重复提示) */}
          {activeBusy && !streamingBuf && !reasoningBuf && approvals.length === 0 && (
            <div className="wb-row">
              <div className="wb-bubble wb-thinking">
                <span className="wb-thinking-dot" />
                <span className="wb-thinking-dot" />
                <span className="wb-thinking-dot" />
                <span className="wb-thinking-text">正在思考</span>
              </div>
            </div>
          )}
          {/* 推理过程实时流(reasoner 模型):收尾落库后由消息内折叠区展示 */}
          {reasoningBuf && (
            <div className="wb-row">
              <div className="wb-bubble wb-reason-live">
                <div className="wb-reason-label">💭 思考过程</div>
                <pre className="wb-reason-text">{reasoningBuf}</pre>
              </div>
            </div>
          )}
          {streamingBuf && (
            <div className="wb-row">
              <div className="wb-bubble">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
                  {streamingBuf}
                </ReactMarkdown>
                <span className="wb-caret" />
              </div>
            </div>
          )}
          {/* 用户上翻阅读时:悬浮「回到底部」胶囊 */}
          {!stick && (
            <button type="button" className="wb-jump" onClick={jumpToBottom}>
              ↓ 最新
            </button>
          )}
        </div>

        {error && <div className="wb-error">✗ {error}</div>}

        <div className="wb-composer">
          <textarea
            ref={taRef}
            className="wb-textarea"
            placeholder={activeId ? '输入问题…(Enter 发送,Shift+Enter 换行)' : '先新建一个会话'}
            value={draft}
            rows={1}
            disabled={!activeId}
            onChange={(e) => {
              setDraft(e.target.value)
              requestAnimationFrame(growTextarea)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                send()
              }
            }}
          />
          <div className="wb-composer-ops">
            <span className="wb-hint">Enter 发送 · Shift+Enter 换行 · 业务查询只读</span>
            {activeBusy ? (
              <button type="button" className="st-btn" onClick={() => void store.stop()}>
                停止生成
              </button>
            ) : (
              <button
                type="button"
                className="st-btn"
                disabled={!canSend || !draft.trim()}
                onClick={send}
              >
                发送
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 新建/重命名会话输入弹窗（Electron 不支持 window.prompt，自绘输入框） */}
      {promptState && (
        <div className="confirm-mask" onClick={closePrompt}>
          <div className="confirm-dialog wb-prompt-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-title">{promptState.title}</div>
            <input
              className="wb-prompt-input"
              autoFocus
              value={promptVal}
              placeholder={promptState.placeholder}
              spellCheck={false}
              onChange={(e) => setPromptVal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void submitPrompt()
                } else if (e.key === 'Escape') {
                  closePrompt()
                }
              }}
            />
            <div className="confirm-actions">
              <button type="button" className="confirm-btn" onClick={closePrompt}>
                取消
              </button>
              <button
                type="button"
                className="confirm-btn confirm-primary"
                disabled={promptBusy || !promptVal.trim()}
                onClick={() => void submitPrompt()}
              >
                {promptState.okLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
