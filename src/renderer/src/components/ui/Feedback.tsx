import type { ReactNode } from 'react'
import './ui.css'

/**
 * 空态与错误条基元（跨页共用）。
 *
 * 来源：这两块最早长在 components/growth/common.tsx（营销仓库用），后来客户页/数据页/看板
 * 各自又写了一份长相不同的空态与红条 —— 同一个"没有数据"在四个页面是四种样子。
 * 现在它们住在这里；growth/common.tsx 只是**转出**（re-export），所以营销页调用点一行没改。
 *
 * 约定：空态必须"说清下一步"（steps 给可执行步骤，而不是"暂无数据"四个字）；
 * 错误条必须能给重试（onRetry 传了就渲染按钮）。
 */
/**
 * 转圈基元（按钮内/加载态共用）。
 *
 * 为什么要有它：慢操作（**首次爆改会先拆解素材，10-30 秒**、媒体重下、批量诊断）此前只有文字
 * 变化甚至毫无变化 —— 用户的原话是「点了以为没反应」。一行 CSS 转圈 + 一句"正在做什么"，
 * 比任何文案都更能说明"它在干活"。
 */
export function Spinner({ size = 12 }: { size?: number }): React.JSX.Element {
  return <span className={'ui-spin'} style={{ width: size, height: size }} aria-hidden="true" />
}

export interface EmptyProps {
  title: string
  /** 可执行的下一步（每步一句话，前面自动编号） */
  steps?: string[]
  /** 额外动作区（按钮等） */
  extra?: ReactNode
}

export function Empty({ title, steps, extra }: EmptyProps): React.JSX.Element {
  return (
    <div className={'ui-empty'}>
      <div className={'ui-empty-title'}>{title}</div>
      {steps && steps.length > 0 ? (
        <div className={'ui-empty-steps'}>
          {steps.map((s, i) => (
            <div className={'ui-empty-step'} key={s}>
              <span className={'no'}>{i + 1}</span>
              <span>{s}</span>
            </div>
          ))}
        </div>
      ) : null}
      {extra}
    </div>
  )
}

export interface ErrBarProps {
  msg: string
  onRetry?: () => void
}

export function ErrBar({ msg, onRetry }: ErrBarProps): React.JSX.Element {
  return (
    <div className={'ui-err'} role={'alert'}>
      <span className={'msg'}>{msg}</span>
      {onRetry ? (
        <button className={'ui-btn sm'} type={'button'} onClick={onRetry}>
          重试
        </button>
      ) : null}
    </div>
  )
}
