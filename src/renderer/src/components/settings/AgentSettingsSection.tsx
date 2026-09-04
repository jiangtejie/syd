import { useCallback, useEffect, useState } from 'react'
import type { AiAgent, AiAgentInput, AiStyle } from '../../../../shared/types'
import { toast } from '../../stores/toast'
import { useWorkbenchStore } from '../../stores/workbench'
import { avatarColor } from '../../lib/ui'

/** 变更成功后同步工作台 store（对话页常驻挂载，仅首挂载拉取会陈旧/悬空） */
function syncWorkbenchAgents(): void {
  useWorkbenchStore.getState().loadAgents()
}

/**
 * 智能体（统一人设）编辑卡。
 * 架构约定(SOP)：本应用所有 AI 能力（智能分析/群问题、AI 工作台、回复建议、IM 自动回复）
 * 统一使用同一条智能体人设，因此界面只提供「编辑当前生效人设」，不提供多智能体
 * 新建/删除/切换/设默认等入口。
 * 存储兼容：ai_agent 沿用既有表结构；如历史存在多条记录，仅「默认行」继续被各通道
 * （主进程 getDefaultAgent/listAgents）使用，编辑保存也只作用于该行。
 */

const agentApi = window.api?.cs?.agent

const AI_STYLE_LABELS: Record<AiStyle, string> = {
  warm: '温暖亲切（推荐客服）',
  formal: '正式专业',
  brief: '简洁干练'
}

const STYLE_KEYS = Object.keys(AI_STYLE_LABELS) as AiStyle[]

/** 表单快照（脏检查基准，纯函数） */
const snapshotOf = (nm: string, ds: string, st: AiStyle, pt: string): string =>
  JSON.stringify([nm, ds, st, pt])

function AgentSettingsSection(): React.JSX.Element {
  const [person, setPerson] = useState<AiAgent | null>(null)
  const [loading, setLoading] = useState(true)
  // 编辑区表单
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [style, setStyle] = useState<AiStyle>('warm')
  const [prompt, setPrompt] = useState('')
  const [saving, setSaving] = useState(false)
  const [errorTip, setErrorTip] = useState('')
  // 最近一次落库的表单快照（脏检查基准）
  const [snapshot, setSnapshot] = useState('')

  /** 用当前生效人设填充表单 */
  const fillPerson = useCallback((a: AiAgent | undefined): void => {
    setPerson(a ?? null)
    setName(a?.name ?? '')
    setDescription(a?.description ?? '')
    setStyle(a?.style ?? 'warm')
    setPrompt(a?.prompt ?? '')
    setSnapshot(
      snapshotOf(a?.name ?? '', a?.description ?? '', a?.style ?? 'warm', a?.prompt ?? '')
    )
  }, [])

  const reload = useCallback(async (): Promise<void> => {
    if (!agentApi) return
    try {
      const res = await agentApi.list()
      if (res.ok && res.agents && res.agents.length > 0) {
        const def = res.agents.find((a) => a.id === res.defaultId) ?? res.agents[0]
        fillPerson(def)
      } else {
        setErrorTip('未找到人设数据，请重启应用后重试')
      }
    } catch (e) {
      setErrorTip(e instanceof Error ? e.message : '加载人设失败')
    } finally {
      setLoading(false)
    }
  }, [fillPerson])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 挂载时一次性异步拉取（回调内 setState，全仓同款模式）
    void reload()
  }, [reload])

  const dirty = snapshot !== snapshotOf(name, description, style, prompt)

  const save = async (): Promise<void> => {
    if (!agentApi || !person?.id) {
      setErrorTip('未找到当前生效人设，请刷新后重试')
      return
    }
    if (!name.trim()) {
      setErrorTip('请填写人设名称')
      return
    }
    const input: AiAgentInput = {
      id: person.id,
      name: name.trim(),
      description: description.trim(),
      style,
      prompt: prompt.trim()
    }
    setSaving(true)
    setErrorTip('')
    try {
      const res = await agentApi.save(input)
      if (!res.ok) {
        setErrorTip(res.error || '保存失败')
      } else if (res.agent) {
        toast.success('人设已保存，所有 AI 能力即时生效')
        fillPerson(res.agent)
        syncWorkbenchAgents()
      } else {
        setErrorTip('保存失败')
      }
    } catch (e) {
      setErrorTip(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className="ag-single ag-loading">加载人设中…</div>
  }
  if (!person) {
    return <div className="ag-single ag-loading">{errorTip || '人设数据不可用'}</div>
  }

  return (
    <div className="ag-single">
      {/* 头部：当前生效人设概览（全端共用一条） */}
      <div className="ag-head">
        <span className="ag-avatar" style={{ background: avatarColor(person.name) }}>
          {(person.name || '?').slice(0, 1)}
        </span>
        <span className="ag-head-title">
          <b>{name.trim() || person.name}</b>
          <em className={`ag-style ag-style-${style}`}>{AI_STYLE_LABELS[style]}</em>
        </span>
        {dirty && <span className="ag-dirty">● 有未保存修改</span>}
      </div>

      <div className="ag-edit">
        <label className="st-row">
          <span className="st-label">名称</span>
          <input
            className="st-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="人设名称，如：微信私域智能客服"
          />
        </label>
        <label className="st-row">
          <span className="st-label">一句话人设</span>
          <input
            className="st-input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="如：熟悉产品线与活动，语气亲和不油腻，能解答订单与售后"
          />
        </label>
        <label className="st-row">
          <span className="st-label">话术风格</span>
          <select
            className="st-input"
            value={style}
            onChange={(e) => setStyle(e.target.value as AiStyle)}
          >
            {STYLE_KEYS.map((k) => (
              <option key={k} value={k}>
                {AI_STYLE_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="st-row">
          <span className="st-label">自定义守则</span>
          <textarea
            className="st-input st-ta"
            rows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={
              '留空时由「名称 + 一句话人设 + 话术风格」自动组装。可写：品牌口径、禁忌词、转人工条件、回复句式偏好等，例如：\n1. 报价必须按最新价目表，不承诺优惠未生效；\n2. 涉及退款/投诉一律引导转人工。'
            }
          />
        </label>
        <div className="st-row ag-actions">
          <button
            type="button"
            className="st-btn"
            disabled={saving || !dirty}
            onClick={() => void save()}
          >
            {saving ? '保存中…' : '保存人设'}
          </button>
          {errorTip && <span className="st-bad">{errorTip}</span>}
        </div>
        <div className="ag-scope">
          此条人设统一用于全部 AI 能力：群问题/工作台等智能分析、回复建议与 IM 通道等智能回复。
          修改保存后即时生效，无需在各页面单独选择或切换。
        </div>
      </div>
    </div>
  )
}

export default AgentSettingsSection
