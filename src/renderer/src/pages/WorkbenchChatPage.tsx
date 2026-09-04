import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatMsgItem } from '../../../shared/types'
import {
  useWorkbenchChatStore,
  subscribeWorkbenchEvents,
  type WbToolCard
} from '../stores/workbenchChat'
import { useWorkbenchStore } from '../stores/workbench'
import { toast } from '../stores/toast'
import './workbench-chat.css'

/**
 * AI 工作台页:让 AI 调用产品原生能力(业务查询/软件状态)+ SKILL.md 业务口径。
 * 引擎基于 Vercel AI SDK(主进程),工具只读;写/危险操作会经确认桥弹窗(v2 启用)。
 */

function WbMessage({ msg }: { msg: ChatMsgItem }): React.JSX.Element {
  const isUser = msg.role === 'user'
  const isError = msg.kind === 'error'
  return (
    <div className={`wb-row${isUser ? ' is-user' : ''}${isError ? ' is-error' : ''}`}>
      <div className="wb-bubble">
        {isError ? (
          <span className="wb-error-text">{msg.content}</span>
        ) : isUser ? (
          <div className="wb-plain">{msg.content}</div>
        ) : (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
        )}
      </div>
    </div>
  )
}

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
  const lastLenRef = useRef(0)
  const store = useWorkbenchChatStore()
  const { chats, activeId, messages, loading, busyIds, streamingBuf, error } = store
  const activeBusy = activeId !== null && !!busyIds[activeId]

  const accountKey = connected ? wxid : ''
  useEffect(() => {
    void store.init(accountKey)
    const off = subscribeWorkbenchEvents()
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 账号切换时重建工作台会话(全仓同款模式)
  }, [accountKey])

  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const total = messages.length + streamingBuf.length
    if (total >= lastLenRef.current) el.scrollTop = el.scrollHeight
    lastLenRef.current = total
  }, [messages, streamingBuf])

  const active = useMemo(
    () => (chats ?? []).find((c) => c.id === activeId) ?? null,
    [chats, activeId]
  )

  const createChat = async (): Promise<void> => {
    const title = window.prompt('工作台会话名称', `会话 ${(chats?.length ?? 0) + 1}`)
    if (title === null) return
    const id = await store.create(title.trim() || `会话 ${(chats?.length ?? 0) + 1}`)
    if (id === null) {
      toast.error('新建会话失败,请重启应用后重试')
    }
  }

  const canSend = !!activeId && !activeBusy
  const send = (): void => {
    const t = draft.trim()
    if (!t || !canSend) return
    setDraft('')
    void store.send(t)
  }

  return (
    <div className="wb-page">
      <aside className="wb-side">
        <button type="button" className="st-btn wb-new" onClick={() => void createChat()}>
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
              <div className="wb-side-title">{c.title}</div>
              <div className="wb-side-ops">
                <button
                  type="button"
                  title="重命名"
                  onClick={(e) => {
                    e.stopPropagation()
                    const t = window.prompt('重命名会话', c.title)
                    if (t && t.trim()) void store.rename(c.id, t.trim())
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
              disabled={!activeId || messages.length === 0}
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
              disabled={!activeId || messages.length === 0}
              onClick={() => {
                if (window.confirm('清空当前会话的消息记录?')) void store.clear(activeId!)
              }}
            >
              清空
            </button>
          </div>
        </div>

        <div className="wb-body" ref={bodyRef}>
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
          {!loading && activeId !== null && messages.map((m) => <WbMessage key={m.id} msg={m} />)}
          {activeId !== null && !loading && messages.length === 0 && !activeBusy && (
            <div className="wb-loading">
              可以试试:「今天有哪些待处理问题?」「XX 客户最近聊了什么?」「导出范围有多大?」
            </div>
          )}
          <WbToolCards />
          <WbApprovals />
          {activeBusy && !streamingBuf && <div className="wb-loading">思考中…</div>}
          {streamingBuf && (
            <div className="wb-row">
              <div className="wb-bubble">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingBuf}</ReactMarkdown>
                <span className="wb-caret" />
              </div>
            </div>
          )}
        </div>

        {error && <div className="wb-error">✗ {error}</div>}

        <div className="wb-composer">
          <textarea
            className="wb-textarea"
            placeholder={activeId ? '输入问题…(Enter 发送,Shift+Enter 换行)' : '先新建一个会话'}
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
    </div>
  )
}
