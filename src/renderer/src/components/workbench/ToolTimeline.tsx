import { useEffect, useState } from 'react'
import { toolCnName } from '../../../../shared/types'
import {
  buildTimelineSteps,
  fmtDuration,
  itemDurationMs,
  timelineSummary,
  type TimelineItem
} from '../../lib/toolTimeline'

/** 时间线头部的终端图标（跟随 currentColor） */
function TerminalIcon(): React.JSX.Element {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2.5" y="4" width="19" height="16" rx="2.5" />
      <path d="m6.5 9 3 3-3 3" />
      <path d="M13 15h5" />
    </svg>
  )
}

/**
 * 工具调用时间线（替代「一次调用一张卡」的平铺）。
 *
 * 展示规则（规则本体的纯函数在 lib/toolTimeline.ts，自检覆盖）：
 * - **竖轴 + 节点**：一步一个节点，按发生顺序自上而下；
 * - **顺序 vs 并行**：后一个调用的开始时间落在当前步结束之前 → 判为同一步内的并行调用，
 *   该步带「N 个并行」标记，子调用缩进并列展示；
 * - **进行中**：节点呼吸 + 实时耗时；结束节点给 ✓/✗ 与耗时；
 * - 点某一步看参数与结果（复用既有 .wb-toolcard-detail* 样式：等宽 + 可复制）。
 */
export function ToolTimeline({
  items,
  title = '工具调用'
}: {
  items: TimelineItem[]
  title?: string
}): React.JSX.Element | null {
  const [openId, setOpenId] = useState<string | null>(null)
  /** 耗时基准：渲染期不许读时钟（react-hooks/purity），所以由 effect 写入、定时器刷新 */
  const [now, setNow] = useState(0)
  const running = items.some((i) => i.status === 'start')

  // 调用集合变化（新调用 / 新结果）时对一次时钟
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 时间线需要当前时间做耗时基准(全仓同款模式)
    setNow(Date.now())
  }, [items])

  // 只有存在进行中的调用时才起定时器（每秒走一次耗时），结束即停
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])

  const steps = buildTimelineSteps(items, now)
  const sum = timelineSummary(steps, now)
  if (items.length === 0) return null

  /** 头部统计：数字走 .ui-num（等宽对齐），空项不占位 */
  const metaBits: React.ReactNode[] = []
  const addMeta = (key: string, n: number, label: string): void => {
    if (metaBits.length > 0) {
      metaBits.push(
        <span key={key + '-sep'} className="wb-tl-sep">
          ·
        </span>
      )
    }
    metaBits.push(
      <span key={key}>
        <b className="ui-num">{n}</b> {label}
      </span>
    )
  }
  if (sum.calls > 1) addMeta('calls', sum.calls, '次调用')
  if (sum.steps > 1) addMeta('steps', sum.steps, '步')
  if (sum.parallelSteps > 0) addMeta('par', sum.parallelSteps, '步并行')
  if (sum.failed > 0) addMeta('fail', sum.failed, '个失败')
  if (sum.running > 0) addMeta('run', sum.running, '个进行中')
  if (sum.running === 0 && sum.durationMs !== undefined) {
    if (metaBits.length > 0) {
      metaBits.push(
        <span key="dur-sep" className="wb-tl-sep">
          ·
        </span>
      )
    }
    metaBits.push(
      <span key="dur" className="ui-num">
        {fmtDuration(sum.durationMs)}
      </span>
    )
  }

  const keyOf = (id: number | string): string => String(id)
  const toggle = (id: number | string): void => {
    const k = keyOf(id)
    setOpenId((cur) => (cur === k ? null : k))
  }

  return (
    <div className={'wb-tl' + (sum.running > 0 ? ' is-running' : '')}>
      <div className="wb-tl-head">
        <span className="wb-tl-kind">
          <TerminalIcon />
          {title}
        </span>
        <span className="wb-tl-meta">{metaBits}</span>
      </div>
      <ol className="wb-tl-body">
        {steps.map((step) => (
          <li
            key={keyOf(step.items[0].id)}
            className={`wb-tl-step${step.parallel ? ' is-parallel' : ''}`}
          >
            {step.items.map((it) => {
              const open = openId === keyOf(it.id)
              const dur = itemDurationMs(it, now)
              const raw = it.name || '工具'
              const label = toolCnName(raw)
              return (
                <div key={keyOf(it.id)} className={`wb-tl-node is-${it.status}`}>
                  <span className="wb-tl-dot" aria-hidden="true" />
                  <button
                    type="button"
                    className="wb-tl-line"
                    aria-expanded={open}
                    title={raw !== label ? `工具名:${raw}` : undefined}
                    onClick={() => toggle(it.id)}
                  >
                    <span className="wb-tl-name">{label}</span>
                    {it.status === 'start' && <em className="wb-tl-state">执行中</em>}
                    {it.status === 'fail' && <em className="wb-tl-state is-fail">失败</em>}
                    {dur !== undefined && dur >= 1000 && (
                      <span className="wb-tl-dur ui-num">{fmtDuration(dur)}</span>
                    )}
                    <span className={`wb-tl-caret${open ? ' is-open' : ''}`}>▸</span>
                  </button>
                  {open && (
                    <div className="wb-tl-detail">
                      {it.args && (
                        <div className="wb-toolcard-sec">
                          <div className="wb-toolcard-detail-title">参数</div>
                          <pre className="wb-toolcard-detail-pre">{it.args}</pre>
                        </div>
                      )}
                      {it.output !== undefined && (
                        <div className="wb-toolcard-sec">
                          <div className="wb-toolcard-detail-title">
                            结果{it.outTrunc ? '（已截断）' : ''}
                          </div>
                          <pre className="wb-toolcard-detail-pre">{it.output}</pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
            {step.parallel && (
              <span className="ui-chip is-sm wb-tl-tag">{step.items.length} 个并行</span>
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}
