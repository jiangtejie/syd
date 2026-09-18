import { useEffect, useState } from 'react'

/**
 * 跨会话「运营备忘」编辑卡(AI 助手 → 工具审批策略 上方)。
 * 用户维护的动态事实,随每轮注入:AI 工作台分析、对客回复建议、IM 自动回复均使用。
 * 每行一条事实即可;保存后即时生效(新的一轮生成开始注入)。
 */

function WorkbenchMemoSection(): React.JSX.Element {
  const [loading, setLoading] = useState(true)
  const [notes, setNotes] = useState('')
  /** 最近一次落库的内容：失焦时没改就不重复写一遍 */
  const [savedValue, setSavedValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedTip, setSavedTip] = useState(false)
  const [errorTip, setErrorTip] = useState('')

  useEffect(() => {
    const api = window.api?.cs?.wb
    if (!api) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 通道缺失时一次性提示(全仓同款模式)
      setLoading(false)
      setErrorTip('备忘通道未就绪')
      return
    }
    void api
      .getMemoNotes()
      .then((res) => {
        if (res.ok) {
          setNotes(res.notes ?? '')
          setSavedValue(res.notes ?? '')
        } else setErrorTip(res.error || '读取备忘失败')
      })
      .catch(() => setErrorTip('读取备忘失败'))
      .finally(() => setLoading(false))
  }, [])

  /** 失焦即存（与设置页同一套语义：输入框失焦落库，不需要「保存」按钮） */
  const save = async (value?: string): Promise<void> => {
    const api = window.api?.cs?.wb
    if (!api) return
    const next = value ?? notes
    if (next === savedValue) return
    setSaving(true)
    setErrorTip('')
    try {
      const res = await api.setMemoNotes(next)
      if (!res.ok) {
        setErrorTip(res.error || '保存失败')
      } else {
        setSavedValue(next)
        setSavedTip(true)
        window.setTimeout(() => setSavedTip(false), 1500)
      }
    } catch (e) {
      setErrorTip(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className="ag-single ag-loading">加载运营备忘中…</div>
  }

  return (
    <div className="ag-single">
      <label className="st-row">
        <span className="st-label">动态事实</span>
        <textarea
          className="st-input st-ta"
          rows={5}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={(e) => void save(e.target.value)}
          placeholder={
            '每行一条跨会话事实,例如:\n客户王女士:按老订单规则走特批流程(截至月底)\n7 月 1 日起报价按 2026-Q3 价目表执行\n物流售后转人工条件:仅出现“破损/丢件”关键词时'
          }
        />
      </label>
      <div className="st-row ag-actions">
        <span className="st-hint">失焦即存，新的一轮生成开始生效</span>
        {saving && <span className="st-hint">保存中…</span>}
        {savedTip && <span className="st-saved">已保存</span>}
        {errorTip && <span className="st-bad">{errorTip}</span>}
      </div>
      <div className="ag-scope">
        注入范围:AI 工作台分析、对话页回复建议、IM 自动回复均会携带本条备忘; 与
        SKILL/自定义守则冲突时模型应以最新备忘为准。超过约 1600 字会被截断,请保持精简。
      </div>
    </div>
  )
}

export default WorkbenchMemoSection
