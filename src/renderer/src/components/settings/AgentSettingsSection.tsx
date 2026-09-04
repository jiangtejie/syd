import { useCallback, useEffect, useState } from 'react'
import type { AiAgent, AiAgentInput, AiStyle } from '../../../../shared/types'
import { toast } from '../../stores/toast'
import { useWorkbenchStore } from '../../stores/workbench'
import { avatarColor } from '../../lib/ui'

/** 变更成功后同步工作台（对话页常驻挂载，仅首挂载拉取会陈旧/悬空） */
function syncWorkbenchAgents(): void {
  useWorkbenchStore.getState().loadAgents()
}
import ConfirmDialog from '../ConfirmDialog'

/**
 * 智能体（客服人设）管理卡。
 * 多智能体维护：新建 / 编辑（名称·描述·风格·自定义提示词）/ 删除 / 设为默认。
 * 默认智能体是工作台的初始选择；对话页人设下拉可随时切换（选择会保留，直到再次切换或改默认）。
 * 本页任何变更成功后都同步到工作台 store，避免对话页下拉陈旧。
 */

const agentApi = window.api?.cs?.agent

const AI_STYLE_LABELS: Record<AiStyle, string> = {
  warm: '温暖亲切（推荐客服）',
  formal: '正式专业',
  brief: '简洁干练'
}

/** 列表风格短标签（长文案放表单下拉） */
const AI_STYLE_SHORT: Record<AiStyle, string> = {
  warm: '温暖亲切',
  formal: '正式专业',
  brief: '简洁干练'
}

const STYLE_KEYS = Object.keys(AI_STYLE_LABELS) as AiStyle[]

/** 表单快照（脏检查基准，纯函数） */
const snapshotOf = (nm: string, ds: string, st: AiStyle, pt: string): string =>
  JSON.stringify([nm, ds, st, pt])

function AgentSettingsSection(): React.JSX.Element {
  const [agents, setAgents] = useState<AiAgent[]>([])
  const [defaultId, setDefaultId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // 编辑区表单
  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [style, setStyle] = useState<AiStyle>('warm')
  const [prompt, setPrompt] = useState('')
  const [saving, setSaving] = useState(false)
  const [errorTip, setErrorTip] = useState('')
  // 最近一次落库/载入的表单快照（脏检查用：切换前有未保存修改先确认）
  const [snapshot, setSnapshot] = useState('')
  // 删除确认弹窗：记录待删智能体与确认文案
  const [removeCtx, setRemoveCtx] = useState<{ agent: AiAgent; message: string } | null>(null)

  /** 用智能体填充编辑表单（reload 与列表点选共用）；同步快照作为“未修改”基准 */
  const fillForm = useCallback((a: AiAgent | undefined): void => {
    setEditingId(a?.id ?? null)
    setName(a?.name ?? '')
    setDescription(a?.description ?? '')
    setStyle(a?.style ?? 'warm')
    setPrompt(a?.prompt ?? '')
    setSnapshot(
      snapshotOf(a?.name ?? '', a?.description ?? '', a?.style ?? 'warm', a?.prompt ?? '')
    )
  }, [])

  const reload = useCallback(
    async (keepId?: string | null): Promise<void> => {
      if (!agentApi) return
      try {
        const res = await agentApi.list()
        if (res.ok && res.agents && res.agents.length > 0) {
          setAgents(res.agents)
          setDefaultId(res.defaultId ?? null)
          const targetId =
            keepId && res.agents.some((a) => a.id === keepId)
              ? keepId
              : (res.defaultId ?? res.agents[0].id)
          fillForm(res.agents.find((a) => a.id === targetId))
        }
      } catch (e) {
        setErrorTip(e instanceof Error ? e.message : '加载智能体失败')
      } finally {
        setLoading(false)
      }
    },
    [fillForm]
  )

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 挂载时一次性异步拉取（回调内 setState，全仓同款模式）
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const startNew = (): void => {
    setEditingId(null)
    setName('')
    setDescription('')
    setStyle('warm')
    setPrompt('')
    setSnapshot('')
    setErrorTip('')
  }

  const dirty = snapshot !== snapshotOf(name, description, style, prompt)

  /** 有未保存修改时先确认，防误触切换丢内容 */
  const confirmDiscard = (): boolean =>
    !dirty || window.confirm('当前编辑内容尚未保存，切换后将丢失这些修改。确定继续？')

  /** 点选列表项（带脏检查） */
  const pick = (a: AiAgent): void => {
    if (!confirmDiscard()) return
    fillForm(a)
  }

  /** 新建（带脏检查） */
  const handleNew = (): void => {
    if (!confirmDiscard()) return
    startNew()
  }

  const save = async (): Promise<void> => {
    if (!agentApi || !name.trim()) {
      setErrorTip('请填写智能体名称')
      return
    }
    const input: AiAgentInput = {
      id: editingId ?? undefined,
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
        toast.success('智能体已保存')
        await reload(res.agent.id)
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

  // 点「删除」→ 弹自绘确认框（删除不可撤销，需二次确认）
  const remove = (a: AiAgent): void => {
    if (!agentApi) return
    if (agents.length <= 1) {
      setErrorTip('至少保留一个智能体')
      return
    }
    const isDefault = a.id === defaultId
    setRemoveCtx({
      agent: a,
      message: isDefault
        ? `「${a.name}」是默认智能体，删除后默认将自动切到第一个。确认删除？`
        : `确认删除智能体「${a.name}」？`
    })
  }

  const doRemove = async (agent: AiAgent): Promise<void> => {
    if (!agentApi) return
    setRemoveCtx(null)
    try {
      const res = await agentApi.remove(agent.id)
      if (res.ok) {
        toast.success('已删除')
        syncWorkbenchAgents()
        const list = await agentApi.list()
        if (list.ok && list.agents) {
          setAgents(list.agents)
          setDefaultId(list.defaultId ?? list.agents[0]?.id ?? null)
          // 优先保留正在编辑的项；被删则回落默认/首项
          const target =
            list.agents.find((x) => x.id === editingId) ??
            list.agents.find((x) => x.id === list.defaultId) ??
            list.agents[0]
          if (target) fillForm(target)
        }
      } else {
        setErrorTip(res.error || '删除失败')
      }
    } catch (e) {
      setErrorTip(e instanceof Error ? e.message : '删除失败')
    }
  }

  const setAsDefault = async (id: string): Promise<void> => {
    if (!agentApi) return
    try {
      const res = await agentApi.setDefault(id)
      if (res.ok) {
        setDefaultId(id)
        toast.success('已设为默认智能体')
        syncWorkbenchAgents()
      } else {
        setErrorTip(res.error || '操作失败')
      }
    } catch (e) {
      setErrorTip(e instanceof Error ? e.message : '操作失败')
    }
  }

  return (
    <div className="ag-wrap">
      {/* 列表 */}
      <div className="ag-list-col">
        <button type="button" className="ag-add" onClick={handleNew}>
          + 新建智能体
        </button>
        <div className="ag-list">
          {loading && <div className="ag-empty">加载中…</div>}
          {!loading && agents.length === 0 && <div className="ag-empty">暂无智能体，请新建</div>}
          {agents.map((a) => (
            <div
              key={a.id}
              className={`ag-item${a.id === editingId ? ' is-active' : ''}`}
              onClick={() => pick(a)}
            >
              <div className="ag-item-top">
                <span className="ag-avatar" style={{ background: avatarColor(a.name) }}>
                  {(a.name || '?').slice(0, 1)}
                </span>
                <span className="ag-item-title">
                  <b>{a.name}</b>
                  {a.id === defaultId && <span className="ag-tag">默认</span>}
                </span>
                <span className={`ag-style ag-style-${a.style}`}>{AI_STYLE_SHORT[a.style]}</span>
              </div>
              {a.description && <div className="ag-item-desc">{a.description}</div>}
              <div className="ag-item-actions">
                {a.id !== defaultId && (
                  <button
                    type="button"
                    className="ag-mini"
                    onClick={(e) => {
                      e.stopPropagation()
                      void setAsDefault(a.id)
                    }}
                  >
                    设为默认
                  </button>
                )}
                <button
                  type="button"
                  className="ag-mini danger"
                  onClick={(e) => {
                    e.stopPropagation()
                    void remove(a)
                  }}
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 编辑区 */}
      <div className="ag-edit">
        <div className="ag-edit-head">
          <span className={`ag-edit-subject${editingId ? '' : ' is-new'}`}>
            {editingId
              ? `正在编辑 · ${agents.find((x) => x.id === editingId)?.name ?? ''}`
              : '正在新建智能体'}
          </span>
          {editingId === defaultId && <span className="ag-edit-default">默认人设</span>}
          {dirty && <span className="ag-dirty">● 有未保存修改</span>}
        </div>
        <label className="st-row">
          <span className="st-label">名称</span>
          <input
            className="st-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如：热情糖水客服"
          />
        </label>
        <label className="st-row">
          <span className="st-label">一句话人设</span>
          <input
            className="st-input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="如：熟悉奶茶/甜品产品线，语气亲和不油腻，能解答订单与售后"
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
              '留空时人设自动由「名称 + 一句话人设 + 话术风格」组装。可写：品牌口径、禁忌词、转人工条件、回复句式偏好等，例如：\n1. 报价必须按最新价目表，不承诺优惠未生效；\n2. 涉及退款/投诉一律引导转人工。'
            }
          />
        </label>
        <div className="st-row ag-actions">
          <button type="button" className="st-btn" disabled={saving} onClick={() => void save()}>
            {saving ? '保存中…' : editingId ? '保存修改' : '保存新智能体'}
          </button>
          {errorTip && <span className="st-bad">{errorTip}</span>}
        </div>
      </div>

      <ConfirmDialog
        options={
          removeCtx
            ? {
                title: '删除智能体？',
                message: removeCtx.message,
                confirmText: '删除',
                danger: true,
                onConfirm: () => void doRemove(removeCtx.agent)
              }
            : null
        }
        onClose={() => setRemoveCtx(null)}
      />
    </div>
  )
}

export default AgentSettingsSection
