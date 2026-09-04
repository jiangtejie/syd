import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useWorkbenchStore } from '../stores/workbench'
import { useAiChatStore } from '../stores/aiChat'
import type { ChatMsgItem } from '../../../shared/types'
import './ai.css'

/**
 * AI 助手页(DeepSeek 式对话;docs/ai-assistant-design.md §2/§10)。
 * 会话侧栏 + 主聊天区(流式 Markdown/工具卡/智能体选择/停止重试)。
 */

/** 消息正文:文本 | 工具结果 | 错误 */
function MessageBubble({ msg }: { msg: ChatMsgItem }): React.JSX.Element {
  const isUser = msg.role === 'user'
  const isError = msg.kind === 'error'
  const isTool = msg.kind === 'tool_result'
  return (
    <div className={`aichat-row ${isUser ? 'is-user' : ''}${isError ? ' is-error' : ''}`}>
      <div className="aichat-bubble">
        {isTool && <div className="aichat-tool-tag">🔧 工具结果</div>}
        {isError ? (
          <span className="aichat-error-text">{msg.content}</span>
        ) : isUser ? (
          <div className="aichat-plain">{msg.content}</div>
        ) : (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
        )}
      </div>
    </div>
  )
}

/** 流式预览(未落库的实时输出) */
function StreamingBubble({ text }: { text: string }): React.JSX.Element | null {
  if (!text) return null
  return (
    <div className="aichat-row">
      <div className="aichat-bubble">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
        <span className="aichat-caret" />
      </div>
    </div>
  )
}

function ToolCardRow(): React.JSX.Element | null {
  const cards = useAiChatStore((s) => s.toolCards)
  const confirmTool = useAiChatStore((s) => s.confirmTool)
  if (!cards.length) return null
  return (
    <div className="aichat-toolcards">
      {cards.map((c) => (
        <div key={c.id} className={`aichat-toolcard is-${c.status}`}>
          <span className="aichat-toolcard-name">
            {c.status === 'start' && '⚙ '}
            {c.status === 'pending' && '❓ '}
            {c.status === 'done' && '✓ '}
            {c.status === 'fail' && '✗ '}
            {c.name}
          </span>
          {c.args && <code className="aichat-toolcard-args">{c.args}</code>}
          {c.result && <div className="aichat-toolcard-result">{c.result}</div>}
          {c.status === 'pending' && c.runId && (
            <div className="aichat-toolcard-ops">
              <span className="aichat-pending-tip">该工具可能产生外部影响,请确认</span>
              <button
                type="button"
                className="ai-btn primary sm"
                onClick={() => void confirmTool(c.runId!, true)}
              >
                允许执行
              </button>
              <button
                type="button"
                className="ai-btn sm"
                onClick={() => void confirmTool(c.runId!, false)}
              >
                拒绝
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

export default function AiChatPage(): React.JSX.Element {
  const wxid = useWorkbenchStore((s) => s.wxid)
  const connected = !!wxid && wxid !== 'wxid_demo'
  const store = useAiChatStore()

  const [draft, setDraft] = useState('')
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const lastLenRef = useRef(0)

  const { chats, activeId, messages, loading, busy, streamingBuf, error, agents, agentId } = store

  useEffect(() => {
    void store.init(connected ? wxid : '')
    const unsub = store.subscribe()
    return unsub
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected ? wxid : ''])

  // 新消息/流式增长自动滚到底
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const total = messages.length + streamingBuf.length
    if (total >= lastLenRef.current) {
      el.scrollTop = el.scrollHeight
    }
    lastLenRef.current = total
  }, [messages, streamingBuf])

  const activeChat = useMemo(() => chats.find((c) => c.id === activeId) ?? null, [chats, activeId])

  const canSend = connected && !busy
  const send = (): void => {
    const t = draft.trim()
    if (!t || !canSend) return
    setDraft('')
    void store.send(t)
  }

  const stop = (): void => void store.stop()
  const retry = (): void => void store.retry()

  const copyText = async (): Promise<void> => {
    const text = messages
      .map((m) => `${m.role === 'user' ? '我' : 'AI'}:\n${m.content}`)
      .join('\n\n')
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="aichat-page">
      {/* 会话侧栏 */}
      <aside className="aichat-side">
        <button type="button" className="ai-btn primary aichat-new" onClick={store.newChat}>
          ＋ 新对话
        </button>
        <div className="aichat-side-list">
          {chats.length === 0 && <div className="aichat-empty">暂无会话</div>}
          {chats.map((c) => (
            <div
              key={c.id}
              className={`aichat-side-item${activeId === c.id ? ' is-active' : ''}`}
              onClick={() => void store.selectChat(c.id)}
            >
              <div className="aichat-side-title">{c.title}</div>
              <div className="aichat-side-ops">
                <button
                  type="button"
                  title="重命名"
                  onClick={(e) => {
                    e.stopPropagation()
                    const t = window.prompt('重命名会话', c.title)
                    if (t && t.trim()) void store.renameChat(c.id, t.trim())
                  }}
                >
                  改
                </button>
                <button
                  type="button"
                  title="删除会话"
                  onClick={(e) => {
                    e.stopPropagation()
                    if (window.confirm(`删除会话「${c.title}」及其全部消息?`)) {
                      void store.removeChat(c.id)
                    }
                  }}
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
        {!connected && (
          <div className="aichat-side-tip">未连接微信:可纯聊天;业务工具需要先在 设置 连接账号</div>
        )}
      </aside>

      {/* 主聊天区 */}
      <div className="aichat-main">
        <div className="aichat-head">
          <div className="aichat-head-title">
            {activeChat ? (
              <>
                <b>{activeChat.title}</b>
                <button
                  type="button"
                  className="ai-mini"
                  onClick={() => {
                    const t = window.prompt('重命名会话', activeChat.title)
                    if (t && t.trim()) void store.renameChat(activeChat.id, t.trim())
                  }}
                >
                  重命名
                </button>
              </>
            ) : (
              <b>新对话</b>
            )}
          </div>
          <div className="aichat-head-right">
            <select
              className="ai-select"
              value={agentId ?? ''}
              onChange={(e) => void store.chooseAgent(e.target.value || null)}
              title="选择智能体(人设),影响后续回复"
            >
              {!agentId && <option value="">默认助手</option>}
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="ai-mini"
              onClick={() => void copyText()}
              title="复制全部消息"
            >
              复制
            </button>
            <button
              type="button"
              className="ai-mini danger"
              disabled={!activeChat || messages.length === 0}
              onClick={() => {
                if (window.confirm('清空当前会话的消息记录?')) void store.clearChat()
              }}
              title="清空当前会话消息"
            >
              清空
            </button>
          </div>
        </div>

        <div className="aichat-body" ref={bodyRef}>
          {!activeId && (
            <div className="aichat-welcome">
              <div className="aichat-welcome-title">微信私域智能助手</div>
              <div className="aichat-welcome-sub">
                选一个智能体开始对话。可提问业务问题(本群客诉、监控概览、客户画像、最近消息),需要时助手会自动调用本地工具。
              </div>
            </div>
          )}
          {loading && <div className="aichat-loading">加载中…</div>}
          {!loading && messages.map((m) => <MessageBubble key={m.id} msg={m} />)}
          {activeId && !loading && messages.length === 0 && (
            <div className="aichat-loading">还没有消息,输入第一句开始</div>
          )}
          <ToolCardRow />
          <StreamingBubble text={streamingBuf} />
          {busy && !streamingBuf && <div className="aichat-thinking">思考中…</div>}
        </div>

        {error && <div className="aichat-error">✗ {error}</div>}

        <div className="aichat-composer">
          <textarea
            className="aichat-textarea"
            placeholder={
              connected
                ? '输入问题…(Enter 发送,Shift+Enter 换行)'
                : '先到 设置 → 微信数据与密钥 连接账号'
            }
            value={draft}
            rows={1}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
          />
          <div className="aichat-composer-ops">
            <span className="aichat-hint">Enter 发送 · Shift+Enter 换行</span>
            {busy ? (
              <button type="button" className="ai-btn" onClick={stop}>
                停止生成
              </button>
            ) : (
              <>
                {messages.some((m) => m.role === 'user') && (
                  <button
                    type="button"
                    className="ai-btn"
                    onClick={retry}
                    title="重新生成上一条回复"
                  >
                    重试
                  </button>
                )}
                <button
                  type="button"
                  className="ai-btn primary"
                  disabled={!canSend || !draft.trim()}
                  onClick={send}
                >
                  发送
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
