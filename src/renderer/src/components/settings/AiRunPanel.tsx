import { useState } from 'react'
import { useAsyncEffect } from '../../lib/useAsyncEffect'
import type { AiRunSummaryView } from '../../../../shared/api'

/**
 * AI 运行与成本（近 N 天，**落库**）。
 *
 * 与上面那张「AI 通道可靠性」的区别：那张是本次运行的内存态（重启清零、只覆盖工作台）；
 * 这张是库里每次真实调用的记录，覆盖**所有模块**（含后台的群问题提取与数字员工值班）。
 * 「昨天失败几次 / 哪个模块总失败 / 这个月烧了多少 token」只能靠它回答。
 */

function fmtAt(at: number): string {
  const d = new Date(at)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** token 一律用紧凑写法：面板上一串 8 位数没人读得出来量级 */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(n)
}

/** 模块名的中文说法（没列到的原样显示，别把未知模块藏起来） */
const MODULE_LABEL: Record<string, string> = {
  chat: 'AI 对话',
  suggest: '回复建议',
  'issue-analyze': '群问题分析',
  'issue-extract': '议题提炼',
  duty: '数字员工',
  intent: '意图识别',
  buzz: '舆情分析',
  // 营销模块 2026-09 已整体下线：这几个 domain 不会再产生新记录，但 ai_run 的历史行还在，
  // 标签留着才不会把老记录显示成一串裸英文 domain。
  'growth-ai': '营销 AI（已下线）',
  'growth-remix': '爆改（已下线）'
}

/**
 * @param days 受控范围（设置页的「AI 运行与成本」卡用它切换 本次运行/1/7/30 天）。
 *   不传则保留自己的天数按钮，供独立使用。
 */
function AiRunPanel({ days: daysProp }: { days?: number } = {}): React.JSX.Element {
  const [daysState, setDaysState] = useState(7)
  const days = daysProp ?? daysState
  const [sum, setSum] = useState<AiRunSummaryView | null>(null)
  const [tip, setTip] = useState('')

  const reload = async (d: number): Promise<void> => {
    const api = window.api?.cs?.ai
    if (!api?.runSummary) {
      setTip('通道未就绪（改到主进程/preload 后需完全重启应用）')
      return
    }
    const res = await api.runSummary(d).catch(() => null)
    if (!res) {
      setTip('读取失败')
      return
    }
    if (!res.ok || !res.summary) {
      setTip(res.error ?? '读取失败')
      return
    }
    setTip('')
    setSum(res.summary)
  }

  useAsyncEffect(() => reload(days), [days])

  const rate = sum ? Math.round(sum.okRate * 100) : null
  const tone = rate === null ? 'none' : rate >= 95 ? 'ok' : rate >= 80 ? 'mid' : 'bad'

  return (
    <div className="ag-single">
      {sum ? (
        <div className="rel-grid">
          <div className={`rel-rate is-${tone}`}>{rate === null ? '—' : `${rate}%`}</div>
          <div className="rel-meta">
            <span>
              近 {sum.days} 天：调用 {sum.total} · 成功 {sum.ok} · 失败 {sum.fail} · token{' '}
              {fmtTokens(sum.tokensIn + sum.tokensOut)}（入 {fmtTokens(sum.tokensIn)} / 出{' '}
              {fmtTokens(sum.tokensOut)}）
            </span>
            <button type="button" className="ui-btn is-sm" onClick={() => void reload(days)}>
              刷新
            </button>
            {daysProp === undefined &&
              [1, 7, 30].map((d) => (
                <button
                  key={d}
                  type="button"
                  className={`ui-btn is-sm${d === days ? ' is-primary' : ''}`}
                  onClick={() => setDaysState(d)}
                >
                  {d} 天
                </button>
              ))}
          </div>

          {sum.total === 0 && (
            <div className="ag-scope">
              还没有调用记录。跑一次「群问题分析」「回复建议」或 AI 工作台就会出现；记录只留本机。
            </div>
          )}

          {sum.byModule.length > 0 && (
            <div className="rel-fails">
              <div className="rel-fails-title">按模块</div>
              {sum.byModule.slice(0, 8).map((m) => (
                <div key={m.module} className="rel-fail" title={m.module}>
                  <time>{MODULE_LABEL[m.module] ?? m.module}</time>
                  <span>
                    {m.total} 次 · 失败 {m.fail} · 平均 {m.avgLatencyMs}ms · token{' '}
                    {fmtTokens(m.tokensIn + m.tokensOut)}
                  </span>
                </div>
              ))}
            </div>
          )}

          {sum.topErrors.length > 0 && (
            <div className="rel-fails">
              <div className="rel-fails-title">失败原因 Top</div>
              {sum.topErrors.map((e, i) => (
                <div key={i} className="rel-fail" title={e.kind}>
                  <time>{e.n} 次</time>
                  <span>
                    {e.kind}
                    {e.code ? ` · ${e.code}` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}

          {sum.lastFailures.length > 0 && (
            <div className="rel-fails">
              <div className="rel-fails-title">最近失败</div>
              {sum.lastFailures.map((f, i) => (
                <div
                  key={i}
                  className="rel-fail"
                  title={`${f.module} · ${f.errorKind} · ${f.errorCode}`}
                >
                  <time>{fmtAt(f.at)}</time>
                  <span>
                    {MODULE_LABEL[f.module] ?? f.module} · {f.errorKind}
                    {f.errorCode ? ` · ${f.errorCode}` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="ag-loading">{tip || '读取中…'}</div>
      )}
      <div className="ag-scope">
        每次真实模型调用记一行（重试的每一次尝试都算，因为每次都计费）；用户主动取消也记为失败，
        便于区分「通道有问题」和「自己点了停止」。只记元信息（模块/模型/耗时/token/错误码），不记调用内容；
        记录按设置里的保留期清理。
      </div>
    </div>
  )
}

export default AiRunPanel
