/**
 * 对话回复的公共渲染组件：AI 工作台（客服）与 AI 助手共用同一套「渲染技能」——
 * Markdown 正文（表格 / 任务清单 / 告警块 / 代码块）、hover 复制、思考过程（终稿折叠 + 生成中实时）、
 * 引用来源、Token 脚注、回答反馈、流式光标。
 *
 * 之所以抽出来：两处原来各写一套，其中一处只渲染纯文本，回复一多样式就单薄（能力还会持续分叉）。
 * 页面只负责外层的行列布局与气泡底色（气泡记得带 .md-host），回复内部一律用这里；
 * 纯逻辑在 ./msgMeta，样式在 ./rich.css（.md-* 前缀）。
 */

import { useEffect, useState } from 'react'
import ReactMarkdown, { defaultUrlTransform, type UrlTransform } from 'react-markdown'
import { toolCnName } from '../../../../shared/types'
import { toast } from '../../stores/toast'
import { MD_REMARK_PLUGINS } from '../workbench/mdPlugins'
import { copyToClipboard, fmtDur, fmtThousand, type EvItem, type Tokens } from './msgMeta'
import './rich.css'

/**
 * 链接：外部打开（主进程对 window.open 统一走系统浏览器），不在应用内导航。
 * 注意把 react-markdown 传进来的 node（hast 节点）拆掉：它会被当成属性渲染成
 * node="[object Object]"，DOM 里一直挂着这么个脏属性（预览里实测）。
 */
function MdLink({
  node,
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }): React.JSX.Element {
  // node 只为了把它从 ...props 里摘出去，不进 DOM
  void node
  const { href, children, ...rest } = props
  return (
    <a {...rest} href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  )
}

/** 图片：限高防撑爆气泡；加载失败就地隐藏；URL 流式成型时 src 变化自动复位 */
function MdImg(props: React.ImgHTMLAttributes<HTMLImageElement>): React.JSX.Element | null {
  const [failed, setFailed] = useState(false)
  const src = props.src
  // 流式中图片 URL 是逐步成型的：URL 变化时复位失败态，避免残缺 URL 404 后永久隐藏
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

/** 固定组件映射（模块级稳定引用）：终稿与流式缓冲共用同一套渲染语义 */
const MD_COMPONENTS = { a: MdLink, img: MdImg }

/**
 * 放行应用内的自定义协议：ct-media://（解密后的聊天媒体，见 media/mediaProtocol.ts）。
 * react-markdown 默认只认 http(s)/mailto 等，命中不了就把整条 URL 抹成空串——
 * 结果是回复里的 ![](ct-media://...) 凭空消失（预览里实测复现，图片那一段只剩空 <p>）。
 * 其余一律交回默认实现，不让 javascript: 之类的协议漏进来。
 *
 * 注：营销模块曾有一条 ct-growth://（素材/生图本地文件），随该模块 2026-09 下线一并撤掉 ——
 * 协议不再注册，放行它只会让失效 URL 变成请求失败的空图。
 */
const APP_PROTOCOL = /^ct-media:/i
const mdUrlTransform: UrlTransform = (url) =>
  APP_PROTOCOL.test(url) ? url : defaultUrlTransform(url)

/** Markdown 正文：表格 / 任务清单 / 删除线 / 自动链接（remark-gfm）+ GitHub 风格告警块 */
export function RichText({
  text,
  className
}: {
  text: string
  className?: string
}): React.JSX.Element {
  return (
    <div className={className ? 'md-body ' + className : 'md-body'}>
      <ReactMarkdown
        remarkPlugins={MD_REMARK_PLUGINS}
        components={MD_COMPONENTS}
        urlTransform={mdUrlTransform}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

/** 复制本条回复（hover 出现在气泡右上角） */
export function MsgCopyButton({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const onCopy = (): void => {
    if (copied) return
    void copyToClipboard(text).then((ok) => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    })
  }
  return (
    <button
      type="button"
      className={'md-copy' + (copied ? ' is-copied' : '')}
      title={copied ? '已复制' : '复制内容'}
      aria-label={copied ? '已复制' : '复制内容'}
      onClick={onCopy}
    >
      {copied ? '✓' : '⧉'}
    </button>
  )
}

/** 终稿的思考过程：默认收起（模型的思考不该抢正文注意力），点击展开回看 */
export function ReasonFold({ text, ms }: { text: string; ms?: number }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (!text) return null
  return (
    <div className="md-reason">
      <button
        type="button"
        className="md-reason-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={'md-reason-caret' + (open ? ' is-open' : '')}>▸</span>
        思考过程 · {text.length} 字{ms !== undefined ? ' · ' + fmtDur(ms) : ''}
      </button>
      {open && <pre className="md-reason-body">{text}</pre>}
    </div>
  )
}

/** 生成中的实时思考卡：默认只显示「思考中」，展开看流式推理 */
export function LiveReason({
  text,
  waitSec
}: {
  text: string
  waitSec: number
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="md-reason-live">
      <button
        type="button"
        className="md-reason-live-head"
        aria-expanded={open}
        title={open ? '收起思考过程' : '展开实时思考过程'}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="md-reason-live-label">
          {open ? '💭 思考过程' : '💭 思考中'}
          {!open && waitSec > 0 ? ' ' + String(waitSec) + 's' : ''}
        </span>
        <span className={'md-reason-live-caret' + (open ? ' is-open' : '')}>▸</span>
      </button>
      {open && (
        <pre className="md-reason-body md-reason-live-body">
          {text || (waitSec > 0 ? '正在整理思路…' : '')}
        </pre>
      )}
    </div>
  )
}

/** 引用来源快照区（证据溯源）：回答里的 [编号] → 该编号的工具行原文，可展开查看 */
export function EvidenceChips({ items }: { items: EvItem[] }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (items.length === 0) return null
  return (
    <div className="md-ev">
      <button
        type="button"
        className="md-ev-toggle"
        aria-expanded={open}
        title="展开查看本段回答引用的工具结果原文行"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="md-ev-icon">◇</span>
        引用来源 · {items.length} 处
        <span className={'md-ev-caret' + (open ? ' is-open' : '')}>▸</span>
      </button>
      {open && (
        <div className="md-ev-list">
          {items.map((it) => (
            <div className="md-ev-item" key={it.n}>
              <span className="md-ev-n">{it.n}</span>
              <span className="md-ev-tool" title={'工具名:' + it.tool}>
                {toolCnName(it.tool)}
              </span>
              <span className="md-ev-line">{it.line}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Token 用量脚注 */
export function TokenLine({ tokens }: { tokens?: Tokens }): React.JSX.Element | null {
  if (!tokens) return null
  const both = typeof tokens.input === 'number' && typeof tokens.output === 'number'
  return (
    <div className="md-tokens" title="本段模型 Token 用量">
      输入 {fmtThousand(tokens.input ?? 0)}
      {both ? ' · ' : ''}
      {typeof tokens.output === 'number' ? '输出 ' + fmtThousand(tokens.output) : ''}
    </div>
  )
}

/** 回答反馈：有用/没用（再点同一按钮=取消；落库供后续优化参考） */
export function FeedbackBar({
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
    <div className="md-feedback">
      <button
        type="button"
        className={'md-fb-btn' + (val === 1 ? ' is-on' : '')}
        title={val === 1 ? '取消反馈' : '这个回答有用'}
        onClick={() => pick(1)}
      >
        👍 {val === 1 ? '已记' : '有用'}
      </button>
      <button
        type="button"
        className={'md-fb-btn' + (val === -1 ? ' is-on no' : '')}
        title={val === -1 ? '取消反馈' : '这个回答没帮助'}
        onClick={() => pick(-1)}
      >
        👎 {val === -1 ? '已记' : '没用'}
      </button>
    </div>
  )
}
