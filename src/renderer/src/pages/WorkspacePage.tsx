import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatMsgItem } from '../../../shared/types'
import { useWorkspaceStore, subscribeWorkspaceEvents, type WsToolCard } from '../stores/workspace'
import { toast } from '../stores/toast'
import '../pages/ai.css'
import './workspace.css'

/**
 * 工作区 Agent(本地自动化副驾 v1;Claude Code 风格)。
 * 自选工作目录 → 会话化聊天:只读文件工具直用,写文件/编辑/执行命令人工确认;
 * 自动注入 CLAUDE.md/AGENTS.md/README 与目录树作项目上下文。与客服 AI 会话相互独立。
 */

function WsMessage({ msg }: { msg: ChatMsgItem }): React.JSX.Element {
  const isUser = msg.role === 'user'
  const isError = msg.kind === 'error'
  return (
    <div className={`aichat-row${isUser ? ' is-user' : ''}${isError ? ' is-error' : ''}`}>
      <div className="aichat-bubble ws-bubble">
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

function WsToolCards(): React.JSX.Element | null {
  const cards = useWorkspaceStore((s) => s.toolCards)
  const confirm = useWorkspaceStore((s) => s.confirm)
  if (cards.length === 0) return null
  return (
    <div className="aichat-toolcards">
      {cards.map((c) => (
        <WsToolCard key={c.id} c={c} onConfirm={(ok) => void confirm(c.runId ?? '', ok)} />
      ))}
    </div>
  )
}

function WsToolCard({
  c,
  onConfirm
}: {
  c: WsToolCard
  onConfirm: (ok: boolean) => void
}): React.JSX.Element {
  return (
    <div className={`aichat-toolcard is-${c.status}`}>
      <span className="aichat-toolcard-name">
        {c.status === 'start' && '⚙ '}
        {c.status === 'pending' && '❓ '}
        {c.status === 'done' && '✓ '}
        {c.status === 'fail' && '✗ '}
        {c.name}
      </span>
      {c.args && <code className="aichat-toolcard-args">{c.args}</code>}
      {c.result && <div className="aichat-toolcard-result">{c.result}</div>}
      {c.status === 'pending' && (
        <div className="aichat-toolcard-ops">
          <span className="aichat-pending-tip">该操作影响工作区文件/命令,请确认(60 秒)</span>
          <button type="button" className="ai-btn primary sm" onClick={() => onConfirm(true)}>
            允许执行
          </button>
          <button type="button" className="ai-btn sm" onClick={() => onConfirm(false)}>
            拒绝
          </button>
        </div>
      )}
    </div>
  )
}

export default function WorkspacePage(): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const lastLenRef = useRef(0)
  const store = useWorkspaceStore()
  const { sessions, activeId, messages, loading, busy, streamingBuf, toolCards, error } = store

  useEffect(() => {
    void store.init()
    const off = subscribeWorkspaceEvents()
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 挂载初始化(全仓同款模式)
  }, [])

  // 流式/新消息自动滚底
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const total = messages.length + streamingBuf.length
    if (total >= lastLenRef.current) el.scrollTop = el.scrollHeight
    lastLenRef.current = total
  }, [messages, streamingBuf])

  const active = useMemo(
    () => (sessions ?? []).find((s) => s.id === activeId) ?? null,
    [sessions, activeId]
  )

  const createWorkspace = async (): Promise<void> => {
    const dir =
      await window.api?.cs?.dialog?.pickDirectory('选择工作目录(AI 只能在该目录内读写与执行)')
    if (!dir?.ok || !dir.path) return
    const name = (dir.path.split(/[\\/]/).filter(Boolean).pop() ?? '工作区').slice(0, 24)
    const title = window.prompt('工作区名称', name)
    const id = await store.create(dir.path, title?.trim() ?? name)
    if (id === null) toast.error('创建失败,请重试')
  }

  const canSend = !busy && !!activeId
  const send = (): void => {
    const t = draft.trim()
    if (!t || !canSend) return
    setDraft('')
    void store.send(t)
  }

  return (
    <div className="aichat-page ws-page">
      {/* 会话侧栏 */}
      <aside className="aichat-side ws-side">
        <button
          type="button"
          className="ai-btn primary aichat-new"
          onClick={() => void createWorkspace()}
        >
          ＋ 新建工作区
        </button>
        <div className="ws-side-tip">
          每个工作区绑定一个目录:AI 只读文件可用;写入/编辑/执行命令会请求你确认。
        </div>
        <div className="aichat-side-list">
          {sessions === null && <div className="aichat-empty">加载中…</div>}
          {sessions !== null && sessions.length === 0 && (
            <div className="aichat-empty">还没有工作区。新建后即可让 AI 在本地目录里干活。</div>
          )}
          {(sessions ?? []).map((s) => (
            <div
              key={s.id}
              className={`aichat-side-item${activeId === s.id ? ' is-active' : ''}`}
              onClick={() => void store.select(s.id)}
            >
              <div className="ws-side-main">
                <div className="aichat-side-title">{s.title}</div>
                <div className="ws-side-cwd" title={s.cwd}>
                  {s.cwd}
                </div>
              </div>
              <div className="aichat-side-ops">
                <button
                  type="button"
                  title="重命名"
                  onClick={(e) => {
                    e.stopPropagation()
                    const t = window.prompt('重命名工作区', s.title)
                    if (t && t.trim()) void store.rename(s.id, t.trim())
                  }}
                >
                  改
                </button>
                <button
                  type="button"
                  title="删除会话"
                  onClick={(e) => {
                    e.stopPropagation()
                    if (window.confirm(`删除工作区「${s.title}」及其全部消息?(文件不会删除)`)) {
                      void store.remove(s.id)
                    }
                  }}
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      </aside>

      {/* 主区 */}
      <div className="aichat-main">
        <div className="aichat-head ws-head">
          <div className="aichat-head-title">
            <b>{active?.title ?? '工作区'}</b>
            {active && (
              <span className="ws-cwd-chip" title={active.cwd}>
                {active.cwd}
              </span>
            )}
          </div>
          <div className="aichat-head-right">
            <button
              type="button"
              className="ai-mini"
              disabled={!active || messages.length === 0}
              title="重试上一轮(重新生成最后回复)"
              onClick={() => void store.retry()}
            >
              重试
            </button>
            <button
              type="button"
              className="ai-mini danger"
              disabled={!activeId}
              onClick={() => void store.stop()}
            >
              停止
            </button>
          </div>
        </div>

        <div className="aichat-body" ref={bodyRef}>
          {!activeId && (
            <div className="aichat-welcome">
              <div className="aichat-welcome-title">工作区助手</div>
              <div className="aichat-welcome-sub">
                选一个本地目录作为工作区,AI 可以读代码、查资料、改文件、跑命令(Claude Code 风格)。
                写入与执行前都会请求你确认;模型沿用 设置 → AI 通道 的配置。
              </div>
            </div>
          )}
          {loading && <div className="aichat-loading">加载中…</div>}
          {!loading && activeId !== null && messages.map((m) => <WsMessage key={m.id} msg={m} />)}
          {activeId !== null && !loading && messages.length === 0 && !busy && (
            <div className="aichat-loading">
              还没有消息。可以试试:「这个目录是做什么的?」「帮我看看 xxx 的代码」「把 xxx 改成 …」
            </div>
          )}
          <WsToolCards />
          {busy && !streamingBuf && toolCards.length === 0 && (
            <div className="aichat-thinking">思考中…</div>
          )}
          {streamingBuf && (
            <div className="aichat-row">
              <div className="aichat-bubble">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingBuf}</ReactMarkdown>
                <span className="aichat-caret" />
              </div>
            </div>
          )}
        </div>

        {error && <div className="aichat-error">✗ {error}</div>}

        <div className="aichat-composer">
          <textarea
            className="aichat-textarea"
            placeholder={active ? `在「${active.cwd}」中执行…(Enter 发送)` : '先新建一个工作区'}
            value={draft}
            rows={1}
            disabled={!activeId}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
          />
          <div className="aichat-composer-ops">
            <span className="aichat-hint">
              Enter 发送 · Shift+Enter 换行 · 写入/命令类操作需确认
            </span>
            {busy ? (
              <button type="button" className="ai-btn" onClick={() => void store.stop()}>
                停止生成
              </button>
            ) : (
              <button
                type="button"
                className="ai-btn primary"
                disabled={!canSend || !draft.trim()}
                onClick={send}
              >
                发送
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
