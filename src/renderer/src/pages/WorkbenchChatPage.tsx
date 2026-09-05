import { memo, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import type { ChatMsgItem } from '../../../shared/types'
import { toolCnName } from '../../../shared/types'
import {
  cleanStreamText,
  ensureWorkbenchEvents,
  useWorkbenchChatStore,
  type WbTurnBlock
} from '../stores/workbenchChat'
import { useWorkbenchStore } from '../stores/workbench'
import { toast } from '../stores/toast'
import { ChannelFileTray } from '../components/workbench/ChannelFileTray'
import { MD_REMARK_PLUGINS } from '../components/workbench/mdPlugins'
import './workbench-chat.css'

/**
 * AI 工作台页:让 AI 调用产品原生能力(业务查询/软件状态)+ SKILL.md 业务口径。
 * 引擎基于 Vercel AI SDK(主进程),工具只读;写/危险操作会经确认桥弹窗(v2 启用)。
 * 交互优化:历史气泡 memo(流式时不重复解析 Markdown)、delta 按帧渲染(带轮次防幽灵帧)、
 * 发送后乐观回显、跟随滚动(用户上翻时不抢滚)、思考动画、中文输入法回车不误发、
 * reasoner 推理过程实时流+落库可折叠回看、超长会话消息窗口化。
 * 回复渲染:富文本组件(表格/任务清单/告警块等)样式见「富文本组件主题」,插件集 mdPlugins。
 */

/** 消息窗口:只渲染最近 N 条(超长会话防整表重排);向上分页翻更早 */
const WB_WINDOW = 200
const WB_OLDER_STEP = 200

/** 命中片段:单行化 + 前后省略 */
function snippet(content: string, width = 84): string {
  const one = content.replace(/\s+/g, ' ').trim()
  if (one.length <= width) return one
  return `…${one.slice(0, width)}…`
}

/** 链接:外部打开(主进程对 window.open 统一走系统浏览器),不在应用内导航 */
function MdLink(props: React.AnchorHTMLAttributes<HTMLAnchorElement>): React.JSX.Element {
  const { href, children, ...rest } = props
  return (
    <a {...rest} href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  )
}

/** 图片:限高防撑爆气泡;加载失败就地隐藏;URL 流式成型时 src 变化自动复位 */
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

/** 复制到剪贴板(navigator.clipboard 失败时回退 execCommand) */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    /* fallthrough */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}

/** 耗时(ms)→ 人类可读(秒/分) */
function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} 秒`
  return `${Math.floor(s / 60)} 分 ${s % 60} 秒`
}

/** 数字 → 千分位(大数值更易读) */
function fmtThousand(n: number): string {
  return Math.round(n).toLocaleString('zh-CN')
}

/**
 * 常用业务提问预设:点击把规范句式填入输入框(工作台按绑定账号实际数据作答)。
 * 模板与 SKILL.md 口径解耦,只负责把问题问清楚。
 */
const WB_PRESETS: Array<{ label: string; text: string; hint: string }> = [
  {
    label: '今日待跟进',
    text: '列出今日需要跟进的待办：群问题中未闭环的、跟进超时的、以及我承诺过要回复的事项。按紧急程度排序，并给出每条建议动作。',
    hint: '今日待跟进清单'
  },
  {
    label: '近 7 天问题汇总',
    text: '汇总近 7 天各群反馈的问题：按群与类型归类，标注仍待处理的条数与严重程度，指出 2-3 个最值得优先处理的。',
    hint: '近 7 天群问题汇总'
  },
  {
    label: '群经营复盘',
    text: '对「当前打开的群」做一份近期复盘：主要讨论主题、客户诉求与情绪变化、已解决与未闭环事项、可复用的经验与下一步动作。',
    hint: '单群经营复盘'
  },
  {
    label: '口径核对',
    text: '请先说明你将依据的 SKILL.md 业务口径，然后核对以下问题是否与口径一致：(请补充要核对的具体说法)。',
    hint: '按口径核对话术'
  },
  {
    label: '写周报素材',
    text: '基于近 7 天工作数据整理周报素材：各群问题处置情况、重点关注事件、自动/人工介入的数据表现、下周建议安排，分条输出便于直接引用。',
    hint: '周报素材整理'
  },
  {
    label: '下一步建议',
    text: '结合本会话前文，先复述我当前的目标，再给 3-5 条可执行的下一步建议，标注每条的优先级与预计耗时。',
    hint: '下一步行动建议'
  }
]

/** 等待态计时(思考/等待首字期间):active 变 true 起计时,false 复位 */
function useWaitElapsed(active: boolean): number {
  const [sec, setSec] = useState(0)
  const startRef = useRef<number | null>(null)
  useEffect(() => {
    if (!active) {
      startRef.current = null
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 等待结束复位秒数(全仓同款模式)
      setSec(0)
      return
    }
    if (startRef.current === null) startRef.current = Date.now()
    const tick = (): void => {
      if (startRef.current !== null) {
        setSec(Math.floor((Date.now() - startRef.current) / 1000))
      }
    }
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [active])
  return sec
}

/** 上下文压缩标记:分隔线样式,点击展开摘要(历史被压缩的透明提示) */
function CompactionMarker({ text }: { text: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="wb-compact">
      <button
        type="button"
        className="wb-compact-head"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="wb-compact-line" />
        <span className="wb-compact-label">旧对话已自动压缩{open ? '' : ' · 点击查看摘要'}</span>
        <span className={`wb-compact-caret${open ? ' is-open' : ''}`}>▸</span>
        <span className="wb-compact-line" />
      </button>
      {open && <div className="wb-compact-body">{text}</div>}
    </div>
  )
}

/** 引用来源条目(meta.evidence 快照:编号 + 工具名 + 行原文) */
interface WbEvItem {
  n: number
  tool: string
  line: string
}

/** 引用来源快照区(证据溯源):回答中的 [编号] 标注 → 该编号的工具行快照,可展开查看 */
function WbEvidenceSources({ items }: { items: WbEvItem[] }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="wb-ev">
      <button
        type="button"
        className="wb-ev-toggle"
        aria-expanded={open}
        title="展开查看本段回答引用的工具结果原文行"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="wb-ev-icon">◇</span>
        引用来源 · {items.length} 处
        <span className={`wb-ev-caret${open ? ' is-open' : ''}`}>▸</span>
      </button>
      {open && (
        <div className="wb-ev-list">
          {items.map((it) => (
            <div className="wb-ev-item" key={it.n}>
              <span className="wb-ev-n">{it.n}</span>
              <span className="wb-ev-tool" title={`工具名:${it.tool}`}>
                {toolCnName(it.tool)}
              </span>
              <span className="wb-ev-line">{it.line}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** 回答反馈:有用/没用(再次点击同一按钮=取消;落库供后续优化参考) */
function WbFeedback({
  sessionId,
  messageId
}: {
  sessionId: number
  messageId: number
}): React.JSX.Element {
  const [val, setVal] = useState<1 | -1 | null>(null)
  const pick = (v: 1 | -1): void => {
    const next = val === v ? null : v
    setVal(next)
    if (next === null) return
    void window.api?.cs?.wb
      ?.feedback({ sessionId, messageId, value: v })
      .then((r) => {
        if (!r?.ok) {
          toast.error(r?.error || '反馈提交失败')
          setVal(null)
        }
      })
      .catch(() => {
        toast.error('反馈提交失败')
        setVal(null)
      })
  }
  return (
    <div className="wb-feedback">
      <button
        type="button"
        className={`wb-fb-btn${val === 1 ? ' is-on' : ''}`}
        title={val === 1 ? '取消反馈' : '这个回答有用'}
        onClick={() => pick(1)}
      >
        👍 {val === 1 ? '已记' : '有用'}
      </button>
      <button
        type="button"
        className={`wb-fb-btn${val === -1 ? ' is-on no' : ''}`}
        title={val === -1 ? '取消反馈' : '这个回答没帮助'}
        onClick={() => pick(-1)}
      >
        👎 {val === -1 ? '已记' : '没用'}
      </button>
    </div>
  )
}

function WbMessageInner({ msg }: { msg: ChatMsgItem }): React.JSX.Element {
  const isUser = msg.role === 'user'
  const isError = msg.kind === 'error'
  const [reasonOpen, setReasonOpen] = useState(false)
  const [copied, setCopied] = useState(false)
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
  const reasoningMs =
    !isUser && !isError && typeof meta?.reasoningMs === 'number' ? meta.reasoningMs : undefined
  const t = meta?.tokens as { input?: number; output?: number } | undefined
  const hasTokens = !!t && (typeof t.input === 'number' || typeof t.output === 'number')
  /** 引用来源快照(meta.evidence → 校验后的条目列表) */
  const evItems = useMemo(() => {
    const raw = meta?.evidence
    if (!Array.isArray(raw)) return []
    const out: WbEvItem[] = []
    for (const it of raw) {
      if (out.length >= 12) break
      if (!it || typeof it !== 'object') continue
      const r = it as Record<string, unknown>
      if (
        typeof r.n === 'number' &&
        typeof r.tool === 'string' &&
        r.tool.length > 0 &&
        typeof r.line === 'string' &&
        r.line.length > 0
      ) {
        out.push({ n: r.n, tool: r.tool, line: r.line })
      }
    }
    return out
  }, [meta])

  const onCopy = (): void => {
    if (copied) return
    void copyToClipboard(content).then((ok) => {
      if (ok) {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1600)
      }
    })
  }
  // 历史行:上下文压缩标记(持久化展示,不再只存在于本轮内存)
  if (!isUser && msg.kind === 'compact') {
    return (
      <div className="wb-row wb-row-compact">
        <CompactionMarker text={content} />
      </div>
    )
  }
  // 历史行:工具痕迹(刷新/切走后可回看调用与结果)
  if (!isUser && msg.kind === 'tool_call') {
    const m = meta as Record<string, unknown> | null
    const toolBlock: WbTurnBlock = {
      id: msg.id,
      kind: 'tool',
      name: typeof m?.name === 'string' && m.name ? m.name : '工具',
      status: m?.status === 'fail' ? 'fail' : 'done',
      args: typeof m?.args === 'string' && m.args ? m.args : undefined,
      output: typeof m?.output === 'string' && m.output ? m.output : undefined
    }
    return <WbToolCard b={toolBlock} />
  }
  return (
    <div className={`wb-row${isUser ? ' is-user' : ''}${isError ? ' is-error' : ''}`}>
      <div className="wb-bubble">
        <button
          type="button"
          className={`wb-bubble-copy${copied ? ' is-copied' : ''}`}
          title={copied ? '已复制' : '复制内容'}
          aria-label={copied ? '已复制' : '复制内容'}
          onClick={onCopy}
        >
          {copied ? '✓' : '⧉'}
        </button>
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
                  {reasoningMs !== undefined ? ` · ${fmtDur(reasoningMs)}` : ''}
                </button>
                {reasonOpen && <pre className="wb-reason-static">{reasoningText}</pre>}
              </div>
            )}
            <ReactMarkdown remarkPlugins={MD_REMARK_PLUGINS} components={MD_COMPONENTS}>
              {content}
            </ReactMarkdown>
            {evItems.length > 0 && <WbEvidenceSources items={evItems} />}
            {hasTokens && (
              <div className="wb-tokens-line" title="本段模型 Token 用量">
                输入 {fmtThousand(t.input ?? 0)}
                {typeof t.input === 'number' && typeof t.output === 'number' ? ' · ' : ''}
                {typeof t.output === 'number' ? `输出 ${fmtThousand(t.output)}` : ''}
              </div>
            )}
            <WbFeedback sessionId={msg.sessionId} messageId={msg.id} />
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

/** 实时推理块:默认收起,生成中只显示「思考中…」,点击展开流式思考内容 */
function WbLiveReason({ text, waitSec }: { text: string; waitSec: number }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="wb-bubble wb-reason-live">
      <button
        type="button"
        className="wb-reason-live-head"
        aria-expanded={open}
        title={open ? '收起思考过程' : '展开实时思考过程'}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="wb-reason-live-label">
          {open ? '💭 思考过程' : '💭 思考中'}
          {!open && waitSec > 0 ? ` ${waitSec}s` : ''}
        </span>
        <span className={`wb-reason-live-caret${open ? ' is-open' : ''}`}>▸</span>
      </button>
      {open && <pre className="wb-reason-text">{text || (waitSec > 0 ? '正在整理思路…' : '')}</pre>}
    </div>
  )
}

function WbToolCard({ b }: { b: WbTurnBlock }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const openRef = useRef(false)
  // 开始执行自动展开(看它要做什么);结束后自动收起,用户手动展开过则保持
  useEffect(() => {
    if (b.status === 'start') {
      openRef.current = false
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 工具状态迁移自动开合(全仓同款模式)
      setOpen(true)
    } else if (b.status === 'done' || b.status === 'fail') {
      if (!openRef.current) setOpen(false)
    }
  }, [b.status])
  const toggle = (): void => {
    openRef.current = !open
    setOpen(!open)
  }
  const statusIcon = b.status === 'start' ? '⚙' : b.status === 'fail' ? '✗' : '✓'
  const toolRaw = b.name || '工具'
  const toolLabel = toolCnName(toolRaw)
  return (
    <div className={`wb-toolcard is-${b.status}`}>
      <button type="button" className="wb-toolcard-head" onClick={toggle} aria-expanded={open}>
        <span className="wb-toolcard-kind">工具调用</span>
        <span
          className="wb-toolcard-name"
          title={toolRaw !== toolLabel ? `工具名:${toolRaw}` : undefined}
        >
          {statusIcon} {toolLabel}
          {b.status === 'start' && <em className="wb-toolcard-state">执行中</em>}
        </span>
        <span className={`wb-toolcard-caret${open ? ' is-open' : ''}`}>▾</span>
      </button>
      {open && (
        <div className="wb-toolcard-detail">
          {b.args && (
            <div className="wb-toolcard-sec">
              <div className="wb-toolcard-detail-title">参数</div>
              <pre className="wb-toolcard-detail-pre">{b.args}</pre>
            </div>
          )}
          {b.output !== undefined && (
            <div className="wb-toolcard-sec">
              <div className="wb-toolcard-detail-title">结果{b.outTrunc ? '（已截断）' : ''}</div>
              <pre className="wb-toolcard-detail-pre">{b.output}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function WbApprovals(): React.JSX.Element | null {
  const approvals = useWorkbenchChatStore((s) => s.approvals)
  const approve = useWorkbenchChatStore((s) => s.approve)
  const trustTool = useWorkbenchChatStore((s) => s.trustTool)
  if (approvals.length === 0) return null
  return (
    <div className="wb-approvals">
      {approvals.map((a) => (
        <div key={a.runId} className="wb-approval">
          <div className="wb-approval-main">
            <span
              className="wb-approval-title"
              title={a.tool !== toolCnName(a.tool) ? `工具名:${a.tool}` : undefined}
            >
              请求执行工具:{toolCnName(a.tool)}
              {a.approvalText && <em className="wb-approval-why">{a.approvalText}</em>}
            </span>
            {a.args && (
              <code className="wb-toolcard-args" title={a.args}>
                {a.args}
              </code>
            )}
          </div>
          <div className="wb-approval-ops">
            <button
              type="button"
              className="st-btn sm"
              title="仅本次允许执行"
              onClick={() => void approve(a.runId, true)}
            >
              允许
            </button>
            <button
              type="button"
              className="st-btn ghost sm"
              title="本会话本轮后续调用该工具不再询问"
              onClick={() => void trustTool(a.runId, a.tool, 'session')}
            >
              本轮允许
            </button>
            <button
              type="button"
              className="st-btn ghost sm"
              title="加入全局「始终允许」名单,之后不再询问(可在 设置 → AI 助手 中撤销)"
              onClick={() => void trustTool(a.runId, a.tool, 'global')}
            >
              始终允许
            </button>
            <button
              type="button"
              className="st-btn ghost danger sm"
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
  const { chats, activeId, messages, loading, busyIds, error, pendingTexts } = store
  const pendingText = activeId !== null ? (pendingTexts[activeId] ?? undefined) : undefined
  const compactBySid = useWorkbenchChatStore((s) => s.compactBySid)
  const contextBySid = useWorkbenchChatStore((s) => s.contextBySid)
  const editingSid = useWorkbenchChatStore((s) => s.editingSid)
  const compactText = activeId !== null ? (compactBySid[activeId] ?? undefined) : undefined
  const ctxInfo = activeId !== null ? (contextBySid[activeId] ?? undefined) : undefined
  const ctxPct =
    ctxInfo && ctxInfo.cap > 0 && ctxInfo.used > 0
      ? Math.min(100, Math.round((ctxInfo.used / ctxInfo.cap) * 100))
      : 0
  const turnBlocks = useWorkbenchChatStore((s) => s.turnBlocks)
  const approvals = useWorkbenchChatStore((s) => s.approvals)
  const sessNew = useWorkbenchChatStore((s) => s.sessNew)
  const sessErr = useWorkbenchChatStore((s) => s.sessErr)
  const activeBusy = activeId !== null && !!busyIds[activeId]
  // 等待首字/思考耗时:正文开始输出(文本段出现)后停止计时;推理/工具/等待期间持续
  const hasLiveText = turnBlocks.some((b) => b.kind === 'text')
  const waitSec = useWaitElapsed(activeBusy && !hasLiveText && activeId !== null)
  const [stick, setStick] = useState(true)
  const stickRef = useRef(true)

  /* ── 选区快捷条(追问这段/复制):作用于气泡正文选区 ── */
  const [quickAsk, setQuickAsk] = useState<{ x: number; y: number; text: string } | null>(null)
  const [quickCopied, setQuickCopied] = useState(false)
  useEffect(() => {
    const updateFromSelection = (): void => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return
      const txt = sel
        .toString()
        .replace(/\u00a0/g, ' ')
        .trim()
      if (txt.length < 2) return
      let node: Node | null = sel.anchorNode
      let inBubble = false
      for (let i = 0; i < 5 && node; i++) {
        if (node instanceof Element) {
          if (node.classList.contains('wb-bubble')) {
            inBubble = true
            break
          }
          node = node.parentElement
        } else {
          node = node.parentElement
        }
      }
      if (!inBubble) return
      const rect = sel.getRangeAt(0).getBoundingClientRect()
      if (!rect || (rect.width <= 0 && rect.height <= 0)) return
      const cx = Math.min(Math.max(rect.left + rect.width / 2, 80), window.innerWidth - 80)
      const cy = Math.max(rect.top - 42, 8)
      setQuickAsk({ x: cx, y: cy, text: txt })
    }
    const onMouseUp = (): void => {
      window.setTimeout(updateFromSelection, 0)
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (
        e.shiftKey &&
        (e.key === 'ArrowLeft' ||
          e.key === 'ArrowRight' ||
          e.key === 'ArrowUp' ||
          e.key === 'ArrowDown')
      ) {
        window.setTimeout(updateFromSelection, 0)
      }
    }
    const onPointerDown = (e: PointerEvent): void => {
      const t = e.target as Element | null
      if (t && t.closest('.wb-quickbar')) return
      setQuickAsk(null)
    }
    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('keyup', onKeyUp)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('keyup', onKeyUp)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [])

  /** 消息窗口化:只渲染最近 WB_WINDOW 条,防止超长会话整表重排;向上可翻更早 */
  // lazy 初始化:切页再回来时组件状态重置,首帧即按当前消息数截尾,避免先全量渲染再校正
  const [startIdx, setStartIdx] = useState(() => Math.max(0, messages.length - WB_WINDOW))
  const pendingAnchorRef = useRef<string | null>(null)
  const visible = useMemo(
    () => (startIdx > 0 ? messages.slice(startIdx) : messages),
    [messages, startIdx]
  )
  // 最近一条用户提问(仅它允许「改写重发」)
  const lastUserMsgId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return messages[i].id
    }
    return null
  }, [messages])
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
    if (el) {
      el.scrollIntoView({ block: 'start' })
      el.classList.add('wb-msg-flash')
      window.setTimeout(() => el.classList.remove('wb-msg-flash'), 2400)
    }
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
  /** 会话行 ✕ → 操作弹层(清空内容 / 删除会话) */
  const [opsChat, setOpsChat] = useState<{ id: number; title: string } | null>(null)
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

  // 内容更新(流式/推理/回显/时间线块/整轮刷新/窗口变化):仅在用户处于底部附近时跟随滚动
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    if (stickRef.current) el.scrollTop = el.scrollHeight
  }, [messages, turnBlocks, pendingText, approvals, loading, startIdx])

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
  /* 待发附图(粘贴/拖入,压缩后 dataURL;改写模式不支持附图) */
  const [pendingImgs, setPendingImgs] = useState<string[]>([])
  const taPlaceholder =
    activeId === null
      ? '先新建一个会话'
      : pendingImgs.length > 0
        ? '已附图片,补充问题后发送…'
        : '输入问题…(可粘贴/拖入图片)'

  /** 图片文件 → 压缩 dataURL(最长边 1280,JPEG 质量自适应 ≤约1.6MB) */
  const compressImage = (file: File): Promise<string | null> =>
    new Promise((resolve) => {
      if (!file.type.startsWith('image/')) {
        resolve(null)
        return
      }
      const reader = new FileReader()
      reader.onerror = (): void => resolve(null)
      reader.onload = (): void => {
        const img = new Image()
        img.onerror = (): void => resolve(null)
        img.onload = (): void => {
          const max = 1280
          const scale = Math.min(1, max / Math.max(img.width, img.height))
          const w = Math.max(1, Math.round(img.width * scale))
          const h = Math.max(1, Math.round(img.height * scale))
          const canvas = document.createElement('canvas')
          canvas.width = w
          canvas.height = h
          const ctx = canvas.getContext('2d')
          if (!ctx) {
            resolve(null)
            return
          }
          ctx.drawImage(img, 0, 0, w, h)
          let q = 0.82
          let url = canvas.toDataURL('image/jpeg', q)
          while (url.length > 1_600_000 && q > 0.5) {
            q -= 0.1
            url = canvas.toDataURL('image/jpeg', q)
          }
          resolve(url.length < 2_600_000 ? url : null)
        }
        if (typeof reader.result === 'string') img.src = reader.result
        else resolve(null)
      }
      reader.readAsDataURL(file)
    })

  const addPendingImage = async (file: File): Promise<void> => {
    if (pendingImgs.length >= 3) {
      toast.error('最多同时附带 3 张图片')
      return
    }
    if (editingSid === activeId) {
      toast.error('改写模式下暂不支持附图')
      return
    }
    const url = await compressImage(file)
    if (!url) {
      toast.error('图片无效或过大(≤8MB,需可解码)')
      return
    }
    setPendingImgs((prev) => (prev.length >= 3 ? prev : [...prev, url]))
  }

  const onComposerPaste = async (e: React.ClipboardEvent): Promise<void> => {
    const item = Array.from(e.clipboardData.items).find((it) => it.type.startsWith('image/'))
    if (!item) return
    e.preventDefault()
    const file = item.getAsFile()
    if (file) void addPendingImage(file)
  }

  const onComposerDrop = async (e: React.DragEvent): Promise<void> => {
    const files = Array.from(e.dataTransfer.files ?? []).filter((f) => f.type.startsWith('image/'))
    if (files.length === 0) return
    e.preventDefault()
    for (const f of files.slice(0, 3 - pendingImgs.length)) void addPendingImage(f)
  }

  const send = (): void => {
    const t = draft.trim()
    if (!canSend) return
    if (!t) {
      if (pendingImgs.length === 0) return
      toast.error('附带图片时请同时输入问题文字')
      return
    }
    const imgs = pendingImgs
    setDraft('')
    setPendingImgs([])
    stickRef.current = true
    setStick(true)
    // 若用户正在翻更早历史,发送后回到贴底窗口
    setStartIdx(Math.max(0, messages.length - WB_WINDOW))
    // 编辑态发送 = 改写最近一轮提问(resend),否则普通提问(可附图)
    if (activeId !== null && editingSid === activeId) void store.sendEdited(t)
    else void store.send(t, imgs)
    // 按钮点击路径恢复输入焦点(回车路径焦点本就在输入框)
    requestAnimationFrame(() => taRef.current?.focus())
  }

  /** 改写最近一条自己的提问:裁掉该轮后填入输入框 */
  const handleEditLastUser = (): void => {
    const text = store.beginEdit()
    if (text === null) return
    setDraft(text)
    requestAnimationFrame(() => {
      growTextarea()
      taRef.current?.focus()
    })
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

  /** 常用提问预设:把规范句式填入输入框并聚焦 */
  const applyPreset = (text: string): void => {
    setDraft(text)
    requestAnimationFrame(() => {
      growTextarea()
      taRef.current?.focus()
    })
  }

  /** 选区追问:把选中内容以引用块带入输入框,用户补充提问后发送 */
  const quoteSelection = (): void => {
    if (!quickAsk) return
    const block = quickAsk.text
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n')
    const base = draft.trim()
    const next = base ? `${base}\n\n${block}\n\n` : `${block}\n\n`
    setDraft(next)
    setQuickAsk(null)
    requestAnimationFrame(() => {
      growTextarea()
      const el = taRef.current
      if (el) {
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
      }
    })
  }

  /** 选区复制 */
  const copySelection = (): void => {
    if (!quickAsk) return
    void copyToClipboard(quickAsk.text).then((ok) => {
      if (ok) {
        setQuickCopied(true)
        window.setTimeout(() => setQuickCopied(false), 1500)
      }
    })
  }

  /** 导出当前会话(Markdown) */
  const exportCurrent = async (): Promise<void> => {
    if (activeId === null) return
    const api = window.api?.cs?.wb
    const res = await api?.exportSession(activeId).catch(() => null)
    if (res?.ok && res.file) {
      toast.success(`已导出:${res.file}`)
    } else {
      const msg = res && !res.ok ? res.error : '导出失败或已取消'
      if (msg && msg !== '已取消') toast.error(msg)
    }
  }

  /** 清空全部工作台会话(二次确认) */
  const clearAllChats = async (): Promise<void> => {
    const total = chats?.length ?? 0
    if (total === 0) return
    const ok = window.confirm(
      `将删除当前账号下全部 ${total} 个工作台会话及其消息(含进行中生成,不可恢复)。确认继续?`
    )
    if (!ok) return
    const api = window.api?.cs?.wb
    const res = await api?.removeAll(accountKey).catch(() => null)
    if (res?.ok) {
      toast.success(`已清空 ${res.removed ?? total} 个会话`)
      await store.init(accountKey)
    } else {
      toast.error(res?.error ?? '清空失败,请重试')
    }
  }

  /* ── 全局快捷键(本页激活期间):Ctrl+N 新建 / Ctrl+Shift+E 导出 / Ctrl+L 聚焦输入 ── */
  const shortcutRef = useRef<{
    promptOpen: boolean
    create: () => void
    exportCur: () => Promise<void>
    focusInput: () => void
  }>({ promptOpen: false, create: () => {}, exportCur: async () => {}, focusInput: () => {} })
  // 渲染后同步最新回调(避免 render 期间写 ref)
  useEffect(() => {
    shortcutRef.current = {
      promptOpen: promptState !== null,
      create: createChat,
      exportCur: exportCurrent,
      focusInput: () => taRef.current?.focus()
    }
  })
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      const k = e.key.toLowerCase()
      if (k === 'n' && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        if (shortcutRef.current.promptOpen) return
        shortcutRef.current.create()
      } else if (k === 'e' && e.shiftKey && !e.altKey) {
        e.preventDefault()
        void shortcutRef.current.exportCur()
      } else if (k === 'l' && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        shortcutRef.current.focusInput()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  /* ── 会话/消息检索 ── */
  interface SearchHit {
    sessionId: number
    sessionTitle: string
    msgId: number
    role: string
    kind: string
    content: string
    createdAt: number
  }
  const [searchQ, setSearchQ] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [searchBusy, setSearchBusy] = useState(false)
  const searchTimerRef = useRef<number | null>(null)

  const runSearch = async (q: string): Promise<void> => {
    const query = q.trim()
    if (!query) {
      setHits(null)
      return
    }
    const api = window.api?.cs?.wb
    setSearchBusy(true)
    const res = await api?.searchChats(accountKey, query).catch(() => null)
    setSearchBusy(false)
    setHits(res?.ok && res.hits ? res.hits : [])
  }

  const onSearchInput = (v: string): void => {
    setSearchQ(v)
    if (searchTimerRef.current !== null) window.clearTimeout(searchTimerRef.current)
    searchTimerRef.current = window.setTimeout(() => {
      searchTimerRef.current = null
      void runSearch(v)
    }, 500)
  }

  /** 命中定位:切会话并滚动到该消息行(窗口截断时调整起点),并高亮闪烁 */
  const openHit = async (hit: SearchHit): Promise<void> => {
    await store.select(hit.sessionId)
    const msgs = useWorkbenchChatStore.getState().messages
    let idx = -1
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].id === hit.msgId) {
        idx = i
        break
      }
    }
    if (idx >= 0) {
      pendingAnchorRef.current = String(hit.msgId)
      stickRef.current = false
      setStartIdx(Math.max(0, idx - 3))
    } else {
      // 命中的消息未在本地(极端情况):正常打开会话即可
      stickRef.current = true
      setStartIdx(Math.max(0, msgs.length - WB_WINDOW))
    }
    setSearchQ('')
    setHits(null)
  }

  const clearSearch = (): void => {
    setSearchQ('')
    setHits(null)
    if (searchTimerRef.current !== null) {
      window.clearTimeout(searchTimerRef.current)
      searchTimerRef.current = null
    }
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
          <div className="wb-side-search">
            <input
              className="wb-side-search-input"
              placeholder="搜索会话与消息…"
              value={searchQ}
              onChange={(e) => onSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  if (searchTimerRef.current !== null) {
                    window.clearTimeout(searchTimerRef.current)
                    searchTimerRef.current = null
                  }
                  void runSearch(searchQ)
                } else if (e.key === 'Escape') {
                  clearSearch()
                }
              }}
            />
            {searchQ && (
              <button
                type="button"
                className="wb-search-clear"
                title="清除搜索"
                onClick={clearSearch}
              >
                ✕
              </button>
            )}
          </div>
          {hits !== null ? (
            <>
              {searchBusy && <div className="wb-empty">搜索中…</div>}
              {!searchBusy && hits.length === 0 && <div className="wb-empty">没有匹配的消息</div>}
              {hits.map((h) => (
                <button
                  key={`${h.sessionId}:${h.msgId}`}
                  type="button"
                  className="wb-search-hit"
                  onClick={() => void openHit(h)}
                  title={`在「${h.sessionTitle}」中定位该消息`}
                >
                  <span className="wb-search-hit-title">
                    {h.sessionTitle}
                    <em className="wb-search-hit-role">
                      {h.role === 'user' ? '我' : h.kind === 'tool_call' ? '工具' : '助手'}
                    </em>
                  </span>
                  <span className="wb-search-hit-text">{snippet(h.content)}</span>
                </button>
              ))}
            </>
          ) : (
            <>
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
                        {!busyIds[c.id] && sessNew[c.id] && (
                          <span className="wb-side-new">新回复</span>
                        )}
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
                      title="会话操作(清空内容/删除)"
                      onClick={(e) => {
                        e.stopPropagation()
                        setOpsChat({ id: c.id, title: c.title })
                      }}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
        {/* 收到的渠道文件(飞书图片/文件):查看与管理,防数据膨胀 */}
        <ChannelFileTray />
        {/* 会话工具:导出当前 / 清空全部 */}
        <div className="wb-side-foot">
          <button
            type="button"
            className="st-btn ghost sm"
            disabled={activeId === null || messages.length === 0}
            title="把当前会话导出为 Markdown(含工具痕迹与思考过程)"
            onClick={() => void exportCurrent()}
          >
            导出会话
          </button>
          <button
            type="button"
            className="st-btn ghost danger sm"
            disabled={chats === null || chats.length === 0}
            title="删除当前账号下的全部工作台会话(不可恢复)"
            onClick={() => void clearAllChats()}
          >
            清空全部
          </button>
        </div>
      </aside>

      <div className="wb-main">
        <div className="wb-head">
          <div className="wb-head-title">
            <b>{active?.title ?? '工作台'}</b>
            <span className="wb-head-sub">AI 工作台 · 调用产品能力</span>
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
          {/* 上下文压缩透明标记(旧历史被摘要折叠) */}
          {!loading && activeId !== null && compactText !== undefined && (
            <CompactionMarker key={activeId} text={compactText} />
          )}
          {!loading && startIdx > 0 && (
            <button type="button" className="wb-older" onClick={loadOlder}>
              ↑ 查看更早 {startIdx} 条
            </button>
          )}
          {!loading &&
            activeId !== null &&
            visible.map((m) => {
              const editTarget =
                m.role === 'user' &&
                m.id === lastUserMsgId &&
                activeBusy === false &&
                editingSid === null
              return (
                <div
                  className={`wb-msg-anchor${editTarget ? ' is-editable' : ''}`}
                  data-wid={m.id}
                  key={m.id}
                >
                  {editTarget && (
                    <button
                      type="button"
                      className="wb-msg-edit"
                      title="改写这个问题并重新提问"
                      onClick={handleEditLastUser}
                    >
                      ✎ 改写
                    </button>
                  )}
                  <WbMessage msg={m} />
                </div>
              )
            })}
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
          {/* 当前轮时间线块:按事件顺序渲染(文本段落 / 工具调用 / 推理过程) */}
          {activeBusy && turnBlocks.length === 0 && approvals.length === 0 && (
            <div className="wb-row">
              <div className="wb-bubble wb-thinking">
                <span className="wb-thinking-dot" />
                <span className="wb-thinking-dot" />
                <span className="wb-thinking-dot" />
                <span className="wb-thinking-text">
                  正在思考{waitSec > 0 ? ` ${waitSec}s` : '…'}
                </span>
              </div>
            </div>
          )}
          {turnBlocks.map((b, i) => {
            if (b.kind === 'tool') {
              return <WbToolCard key={b.id} b={b} />
            }
            if (b.kind === 'reason') {
              return (
                <div key={b.id} className="wb-row">
                  <WbLiveReason
                    text={b.text ?? ''}
                    waitSec={!hasLiveText && waitSec > 0 ? waitSec : 0}
                  />
                </div>
              )
            }
            const isTail = activeBusy && i === turnBlocks.length - 1
            return (
              <div key={b.id} className="wb-row">
                <div className="wb-bubble">
                  <ReactMarkdown remarkPlugins={MD_REMARK_PLUGINS} components={MD_COMPONENTS}>
                    {b.text ?? ''}
                  </ReactMarkdown>
                  {isTail && <span className="wb-caret" />}
                </div>
              </div>
            )
          })}
          {/* 用户上翻阅读时:悬浮「回到底部」胶囊 */}
          {!stick && (
            <button type="button" className="wb-jump" onClick={jumpToBottom}>
              ↓ 最新
            </button>
          )}
        </div>

        {/* 审批统一条:固定在输入区上方,不再随消息流滚动/埋没 */}
        <WbApprovals />

        {error && (
          <div className="wb-error">
            <span>✗ {error}</span>
            {!activeBusy && (
              <button type="button" className="wb-error-retry" onClick={() => void store.retry()}>
                重试
              </button>
            )}
          </div>
        )}

        <div
          className="wb-composer"
          onPaste={(e) => {
            void onComposerPaste(e)
          }}
          onDrop={(e) => {
            void onComposerDrop(e)
          }}
          onDragOver={(e) => e.preventDefault()}
        >
          {/* 上下文占用(字符估算):接近预算时提示即将压缩 */}
          {ctxPct > 0 && (
            <div
              className={`wb-ctxline${ctxPct >= 90 ? ' is-hot' : ''}`}
              title="当前会话上下文估算占用;超过预算会先压缩旧对话再继续"
            >
              <span className="wb-ctxline-label">
                上下文 {ctxPct}%{ctxPct >= 90 ? ' · 接近上限,新一轮将先压缩旧对话' : ''}
              </span>
              <span className="wb-ctxline-bar">
                <i style={{ width: `${ctxPct}%` }} />
              </span>
            </div>
          )}
          {activeId !== null && (
            <div className="wb-presets">
              <span className="wb-presets-tip">常用提问</span>
              <div className="wb-presets-list">
                {WB_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    className="wb-preset-btn"
                    title={p.hint}
                    onClick={() => applyPreset(p.text)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {pendingImgs.length > 0 && (
            <div className="wb-img-row">
              {pendingImgs.map((u, i) => (
                <span key={i} className="wb-img-chip">
                  <img src={u} alt="" />
                  <button
                    type="button"
                    title="移除"
                    onClick={() => setPendingImgs((prev) => prev.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={taRef}
            className="wb-textarea"
            placeholder={taPlaceholder}
            value={draft}
            rows={1}
            disabled={!activeId}
            onChange={(e) => {
              const v = e.target.value
              // 编辑态清空输入 = 放弃改写,恢复会话原始记录
              if (!v && activeId !== null && editingSid === activeId) store.cancelEdit()
              setDraft(v)
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
            <span className="wb-hint">
              Enter 发送 · Shift+Enter 换行 · Ctrl+N 新建 · Ctrl+Shift+E 导出 · Ctrl+L 聚焦输入
            </span>
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

      {/* 会话行 ✕:清空内容 / 删除会话(范围与不可恢复性不同,分开展示确认) */}
      {opsChat && (
        <div className="confirm-mask" onClick={() => setOpsChat(null)}>
          <div className="confirm-dialog wb-ops-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-title">会话操作</div>
            <div className="wb-ops-name">{opsChat.title}</div>
            <div className="wb-ops-list">
              <button
                type="button"
                className="wb-ops-item"
                onClick={() => {
                  const c = opsChat
                  setOpsChat(null)
                  if (
                    window.confirm(`清空会话「${c.title}」的全部消息记录?会话保留,可继续提问。`)
                  ) {
                    void store.clear(c.id)
                  }
                }}
              >
                <b>清空内容</b>
                <span>删掉全部对话记录,会话保留;常用于重开一个干净话题</span>
              </button>
              <button
                type="button"
                className="wb-ops-item danger"
                onClick={() => {
                  const c = opsChat
                  setOpsChat(null)
                  if (window.confirm(`删除会话「${c.title}」?该操作不可恢复。`)) {
                    void store.remove(c.id)
                  }
                }}
              >
                <b>删除会话</b>
                <span>连同历史一起删除,不可恢复</span>
              </button>
            </div>
            <div className="confirm-actions">
              <button type="button" className="confirm-btn" onClick={() => setOpsChat(null)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 选区快捷条:追问这段 / 复制 */}
      {quickAsk && (
        <div
          className="wb-quickbar"
          style={{ left: quickAsk.x, top: quickAsk.y }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <button type="button" className="wb-quickbar-btn" onClick={quoteSelection}>
            ⛭ 追问这段
          </button>
          <button type="button" className="wb-quickbar-btn" onClick={copySelection}>
            {quickCopied ? '✓ 已复制' : '⧉ 复制'}
          </button>
        </div>
      )}
    </div>
  )
}
