import { useEffect, useState } from 'react'
import { toast } from '../../stores/toast'

/**
 * 工具审批策略卡(AI 助手 → 智能体 下方)。
 * 作用于「需要人工确认的写/外部工具」(当前内置工具均只读、不触发审批,为后续写能力预留)。
 * - 模式:每次询问(默认) / 默认允许 / 默认拒绝
 * - 始终允许 / 始终拒绝 名单:优先于默认模式;名单按行或逗号分隔
 * 保存后即时对引擎生效;会话内的「本轮允许」不落此配置,属临时放行。
 */

type WbMode = 'ask' | 'allow' | 'deny'

const MODE_LABELS: Record<WbMode, string> = {
  ask: '每次询问（默认，最安全）',
  allow: '默认允许（写操作仍建议保持询问）',
  deny: '默认拒绝（未列入信任名单的工具一律不执行）'
}

function parseNames(text: string): string[] {
  return text
    .split(/[\n,，、\s]+/)
    .map((s) => s.trim())
    .filter((s) => !!s)
}

function WorkbenchApprovalSection(): React.JSX.Element {
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<WbMode>('ask')
  const [allowText, setAllowText] = useState('')
  const [denyText, setDenyText] = useState('')
  const [saving, setSaving] = useState(false)
  const [errorTip, setErrorTip] = useState('')

  useEffect(() => {
    const api = window.api?.cs?.wb
    if (!api) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 通道缺失时一次性提示(全仓同款模式)
      setLoading(false)
      setErrorTip('工具审批通道未就绪')
      return
    }
    void api
      .getApprovalPrefs()
      .then((res) => {
        const p = res.ok && res.prefs ? res.prefs : null
        if (p) {
          const m: WbMode = p.mode === 'allow' || p.mode === 'deny' ? p.mode : 'ask'
          setMode(m)
          setAllowText((p.allow ?? []).join('\n'))
          setDenyText((p.deny ?? []).join('\n'))
        }
      })
      .catch(() => setErrorTip('读取审批策略失败'))
      .finally(() => setLoading(false))
  }, [])

  const save = async (): Promise<void> => {
    const api = window.api?.cs?.wb
    if (!api) return
    setSaving(true)
    setErrorTip('')
    try {
      const res = await api.setApprovalPrefs({
        mode,
        allow: parseNames(allowText),
        deny: parseNames(denyText)
      })
      if (!res.ok) {
        setErrorTip(res.error || '保存失败')
      } else {
        toast.success('审批策略已保存,即时生效')
      }
    } catch (e) {
      setErrorTip(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className="ag-single ag-loading">加载审批策略中…</div>
  }

  return (
    <div className="ag-single">
      <label className="st-row">
        <span className="st-label">默认策略</span>
        <select
          className="st-input"
          value={mode}
          onChange={(e) => setMode(e.target.value as WbMode)}
        >
          {(Object.keys(MODE_LABELS) as WbMode[]).map((k) => (
            <option key={k} value={k}>
              {MODE_LABELS[k]}
            </option>
          ))}
        </select>
      </label>
      <label className="st-row">
        <span className="st-label">始终允许</span>
        <textarea
          className="st-input st-ta"
          rows={3}
          value={allowText}
          onChange={(e) => setAllowText(e.target.value)}
          placeholder={'每行一个工具名。命中名单的工具执行前不再询问。\n例如: query_issues'}
        />
      </label>
      <label className="st-row">
        <span className="st-label">始终拒绝</span>
        <textarea
          className="st-input st-ta"
          rows={3}
          value={denyText}
          onChange={(e) => setDenyText(e.target.value)}
          placeholder="每行一个工具名。命中名单的工具一律不执行(拒绝优先于默认允许)。"
        />
      </label>
      <div className="st-row ag-actions">
        <button type="button" className="st-btn" disabled={saving} onClick={() => void save()}>
          {saving ? '保存中…' : '保存审批策略'}
        </button>
        {errorTip && <span className="st-bad">{errorTip}</span>}
      </div>
      <div className="ag-scope">
        作用于需要确认的写/外部工具(当前内置工具均为只读,不触发确认)。
        在审批条上点「始终允许」会写入此名单;会话级「本轮允许」为临时放行,不在此保存。
      </div>
    </div>
  )
}

export default WorkbenchApprovalSection
