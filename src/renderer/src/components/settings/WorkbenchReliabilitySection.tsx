import { useEffect, useState } from 'react'

/**
 * AI 通道可靠性卡(本次运行统计):
 * 显示生成成功率与最近失败原因,便于判断通道/模型稳定性。
 * 说明:统计随本次运行累计,重启清零;停止生成不计入失败。
 */

interface RelStats {
  total: number
  ok: number
  fail: number
  rate: number | null
  lastFailures: Array<{ at: number; err: string }>
}

function fmtAt(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

function WorkbenchReliabilitySection(): React.JSX.Element {
  const [stats, setStats] = useState<RelStats | null>(null)
  const [errorTip, setErrorTip] = useState('')

  const reload = async (): Promise<void> => {
    const api = window.api?.cs?.wb
    if (!api) {
      setErrorTip('通道未就绪')
      return
    }
    const res = await api.reliability().catch(() => null)
    if (!res) {
      setErrorTip('读取失败')
      return
    }
    if (!res.ok) {
      setErrorTip(res.error ?? '读取失败')
      return
    }
    if (res.stats) setStats(res.stats)
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 挂载时一次性拉取(回调内 setState,全仓同款模式)
    void reload()
  }, [])

  const tone =
    stats && stats.rate !== null
      ? stats.rate >= 90
        ? 'ok'
        : stats.rate >= 60
          ? 'mid'
          : 'bad'
      : 'none'

  return (
    <div className="ag-single">
      {stats ? (
        <div className="rel-grid">
          <div className={`rel-rate is-${tone}`}>
            {stats.rate !== null ? `${stats.rate}%` : '—'}
          </div>
          <div className="rel-meta">
            <span>
              成功 {stats.ok} / 失败 {stats.fail} / 共 {stats.total}
            </span>
            <button type="button" className="ui-btn is-sm" onClick={() => void reload()}>
              刷新
            </button>
          </div>
          {stats.lastFailures.length > 0 && (
            <div className="rel-fails">
              <div className="rel-fails-title">最近失败原因</div>
              {stats.lastFailures.map((f, i) => (
                <div key={i} className="rel-fail" title={f.err}>
                  <time>{fmtAt(f.at)}</time>
                  <span>{f.err}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="ag-loading">{errorTip || '读取中…'}</div>
      )}
      <div className="ag-scope">
        统计范围为本次应用运行期间的工作台生成请求;瞬时失败已自动重试一次(重试成功不计失败)。停止生成、审批超时不计入。
      </div>
    </div>
  )
}

export default WorkbenchReliabilitySection
