import { fmt, fmtRel, TARGET_KIND_LABEL } from './meta'
import { useCallback, useState } from 'react'
import { toast } from '../../stores/toast'
import SkeletonRows from './SkeletonRows'
import { growthApi } from './meta'
import { Switch, Badge, EmptyState, ErrBar, type BadgeTone } from './common'
import type {
  GrowthCrawlTaskView,
  GrowthSubscription,
  GrowthSubscriptionInput
} from '../../../../shared/growth'
import { useAsyncEffect } from '../../lib/useAsyncEffect'

export interface SubFormState {
  name: string
  target: string
  targetKind: string
  city: string
  bizType: string
  vendor: string
  intervalHours: number
}

const EMPTY_FORM: SubFormState = {
  name: '',
  target: '',
  targetKind: 'keyword',
  city: '',
  bizType: '',
  vendor: '',
  intervalHours: 24
}

export function SourcesPanel({ onChanged }: { onChanged: () => void }): React.JSX.Element {
  const [subs, setSubs] = useState<GrowthSubscription[]>([])
  const [tasks, setTasks] = useState<GrowthCrawlTaskView[]>([])
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<GrowthSubscription | null>(null)
  const [form, setForm] = useState<SubFormState>(EMPTY_FORM)
  const [runningId, setRunningId] = useState<number | null>(null)
  const [confirmId, setConfirmId] = useState<number | null>(null)

  const load = useCallback(async (): Promise<void> => {
    if (!growthApi) return
    setLoadErr('')
    try {
      const [r1, r2] = await Promise.all([growthApi.listSubscriptions(), growthApi.recentTasks(6)])
      if (r1.ok && r1.subscriptions) setSubs(r1.subscriptions)
      if (r2.ok && r2.tasks) setTasks(r2.tasks)
      if (!r1.ok && !r2.ok) setLoadErr(r1.error || r2.error || '加载失败')
      else if (!r1.ok) setLoadErr(r1.error || '加载失败')
      else if (!r2.ok) setLoadErr(r2.error || '加载失败')
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
      onChanged()
    }
  }, [onChanged])

  useAsyncEffect(load, [load])

  const openNew = (): void => {
    setEditing(null)
    setForm(EMPTY_FORM)
    setFormOpen(true)
  }

  const openEdit = (s: GrowthSubscription): void => {
    setEditing(s)
    setForm({
      name: s.name,
      target: s.target,
      targetKind: s.targetKind,
      city: s.city,
      bizType: s.bizType,
      vendor: s.vendor,
      intervalHours: s.intervalHours
    })
    setFormOpen(true)
  }

  const setF = (k: keyof SubFormState, v: string | number): void => {
    setForm((f) => ({ ...f, [k]: v }))
  }

  const save = async (): Promise<void> => {
    if (!growthApi || !form.target.trim()) {
      toast.error('订阅目标不能为空')
      return
    }
    const input: GrowthSubscriptionInput = {
      name: form.name,
      sourceType: 'thirdparty',
      vendor: form.vendor,
      city: form.city,
      bizType: form.bizType,
      targetKind: form.targetKind as GrowthSubscriptionInput['targetKind'],
      target: form.target.trim(),
      storeId: null,
      enabled: editing ? editing.enabled : false,
      intervalHours: form.intervalHours
    }
    const res = await growthApi.saveSubscription(editing ? { ...input, id: editing.id } : input)
    if (!res.ok) {
      toast.error(res.error || '保存失败')
      return
    }
    toast.success(editing ? '订阅已更新' : '订阅已创建')
    setFormOpen(false)
    void load()
  }

  const toggle = async (s: GrowthSubscription): Promise<void> => {
    if (!growthApi) return
    const res = await growthApi.setSubscriptionEnabled(s.id, !s.enabled)
    if (!res.ok) toast.error(res.error || '操作失败')
    else void load()
  }

  const runNow = async (s: GrowthSubscription): Promise<void> => {
    if (!growthApi || runningId !== null) return
    setRunningId(s.id)
    try {
      const res = await growthApi.runCrawl(s.id)
      if (!res.ok) toast.error(res.error || '采集失败')
      else {
        toast.success(
          '采集完成: 拉取 ' +
            String(res.fetched ?? 0) +
            ' 条, 新入库 ' +
            String(res.inserted ?? 0) +
            ' 条'
        )
        void load()
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '采集失败')
    } finally {
      setRunningId(null)
    }
  }

  const remove = async (s: GrowthSubscription): Promise<void> => {
    if (confirmId !== s.id) {
      setConfirmId(s.id)
      setTimeout(() => setConfirmId((v) => (v === s.id ? null : v)), 2500)
      return
    }
    if (!growthApi) return
    const res = await growthApi.deleteSubscription(s.id)
    if (!res.ok) toast.error(res.error || '删除失败')
    else {
      toast.success('订阅已删除')
      void load()
    }
    setConfirmId(null)
  }

  const subStatus = (s: GrowthSubscription): { tone: BadgeTone; text: string; title?: string } => {
    if (s.lastStatus === 'error')
      return { tone: 'red', text: '失败', title: s.lastError || undefined }
    if (s.lastStatus === 'ok') return { tone: 'green', text: '正常' }
    return { tone: 'gray', text: '未采集' }
  }

  return (
    <>
      <div className={'page-card gth-card'}>
        <div className={'gth-card-head'}>
          <span className={'gth-card-title'}>采集订阅</span>
          <span className={'gth-card-sub'}>城市 × 业态 × 关键词/账号/话题/榜单</span>
          <button className={'ui-btn is-primary gth-btn sm'} type={'button'} onClick={openNew}>
            + 添加订阅
          </button>
        </div>
        {loadErr ? <ErrBar msg={loadErr} onRetry={() => void load()} /> : null}
        {loading ? (
          <SkeletonRows rows={5} cols={1} />
        ) : subs.length === 0 && !formOpen ? (
          <EmptyState
            title={'还没有采集订阅'}
            steps={[
              '「数据服务」页填写供应商标识与 API Key(订阅数据服务商后获取)',
              '点击右上「+ 添加订阅」, 按 城市×业态×关键词/账号 创建第一条',
              '在此之前, 可在「素材仓库」页粘贴分享链接先行入库'
            ]}
          />
        ) : null}
        {formOpen ? (
          <div className={'gth-form-grid'} style={{ marginBottom: 12 }}>
            <div className={'gth-field'}>
              <span className={'gth-field-label'}>订阅名</span>
              <input
                className={'ui-input gth-input'}
                value={form.name}
                placeholder={'默认同目标'}
                onChange={(e) => setF('name', e.target.value)}
              />
            </div>
            <div className={'gth-field'}>
              <span className={'gth-field-label'}>目标类型</span>
              <select
                className={'ui-select gth-select'}
                value={form.targetKind}
                onChange={(e) => setF('targetKind', e.target.value)}
              >
                {Object.entries(TARGET_KIND_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
            <div className={'gth-field'}>
              <span className={'gth-field-label'}>
                订阅目标<span className={'req'}>*</span>
              </span>
              <input
                className={'ui-input gth-input'}
                value={form.target}
                placeholder={'如: 成都火锅 / 竞品账号名 / 同城美食话题'}
                onChange={(e) => setF('target', e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void save()
                }}
              />
            </div>
            <div className={'gth-field'}>
              <span className={'gth-field-label'}>城市</span>
              <input
                className={'ui-input gth-input'}
                value={form.city}
                placeholder={'如 成都'}
                onChange={(e) => setF('city', e.target.value)}
              />
            </div>
            <div className={'gth-field'}>
              <span className={'gth-field-label'}>业态</span>
              <input
                className={'ui-input gth-input'}
                value={form.bizType}
                placeholder={'如 火锅'}
                onChange={(e) => setF('bizType', e.target.value)}
              />
            </div>
            <div className={'gth-field'}>
              <span className={'gth-field-label'}>供应商</span>
              <input
                className={'ui-input gth-input'}
                list={'gth-vendors'}
                value={form.vendor}
                placeholder={'如 chanmama'}
                onChange={(e) => setF('vendor', e.target.value)}
              />
            </div>
            <div className={'gth-field'}>
              <span className={'gth-field-label'}>采集间隔</span>
              <select
                className={'ui-select gth-select'}
                value={form.intervalHours}
                onChange={(e) => setF('intervalHours', Number(e.target.value))}
              >
                <option value={1}>每 1 小时</option>
                <option value={6}>每 6 小时</option>
                <option value={12}>每 12 小时</option>
                <option value={24}>每 24 小时(默认)</option>
                <option value={72}>每 3 天</option>
              </select>
            </div>
            <div className={'gth-field'}>
              <span className={'gth-field-label'}>&nbsp;</span>
              <div className={'gth-btn-row'}>
                <button
                  className={'ui-btn is-primary gth-btn'}
                  type={'button'}
                  onClick={() => void save()}
                >
                  {editing ? '保存修改' : '创建订阅'}
                </button>
                <button
                  className={'ui-btn gth-btn'}
                  type={'button'}
                  onClick={() => setFormOpen(false)}
                >
                  取消
                </button>
              </div>
            </div>
          </div>
        ) : null}
        {subs.length > 0 ? (
          <div className={'gth-list'}>
            <div className={'gth-row gth-row--sub is-head'}>
              <span>订阅</span>
              <span>状态</span>
              <span>自动采集</span>
              <span>上次 / 下次采集</span>
              <span className={'gth-col-right'}>操作</span>
            </div>
            {subs.map((s) => {
              const st = subStatus(s)
              return (
                <div className={'gth-row gth-row--sub'} key={s.id}>
                  <div className={'gth-main'}>
                    <div className={'t'}>
                      <span className={'txt'} title={s.name || s.target}>
                        {s.name || s.target}
                      </span>
                      {editing && editing.id === s.id && formOpen ? (
                        <Badge tone="amber">编辑中</Badge>
                      ) : null}
                    </div>
                    <div className={'s'} title={s.target}>
                      {TARGET_KIND_LABEL[s.targetKind] ?? s.targetKind}: {s.target}
                      {[s.city, s.bizType, s.vendor].filter(Boolean).length > 0
                        ? ' · ' + [s.city, s.bizType, s.vendor].filter(Boolean).join(' / ')
                        : ''}
                    </div>
                  </div>
                  <div>
                    <Badge tone={st.tone} title={st.title}>
                      {st.text}
                    </Badge>
                  </div>
                  <div>
                    <Switch
                      checked={s.enabled}
                      onChange={() => void toggle(s)}
                      title={s.enabled ? '停用自动采集' : '启用自动采集(需先配置数据服务)'}
                    />
                  </div>
                  <div className={'gth-num'} title={'下次: ' + fmt(s.nextAt)}>
                    <div>{s.lastAt ? fmt(s.lastAt) : '—'}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-4)' }}>{fmtRel(s.nextAt)}</div>
                  </div>
                  <div className={'gth-actions'}>
                    <button
                      className={'ui-btn gth-btn sm'}
                      type={'button'}
                      disabled={runningId !== null}
                      title={runningId !== null ? '有其他任务进行中' : undefined}
                      onClick={() => void runNow(s)}
                    >
                      {runningId === s.id ? '采集中…' : '立即采集'}
                    </button>
                    <button
                      className={'ui-btn gth-btn sm'}
                      type={'button'}
                      onClick={() => openEdit(s)}
                    >
                      编辑
                    </button>
                    <button
                      className={
                        'ui-btn is-danger gth-btn sm' + (confirmId === s.id ? ' is-solid' : '')
                      }
                      type={'button'}
                      onClick={() => void remove(s)}
                    >
                      {confirmId === s.id ? '确认删除?' : '删除'}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        ) : null}
      </div>

      <div className={'page-card gth-card'}>
        <div className={'gth-card-head'}>
          <span className={'gth-card-title'}>最近采集任务</span>
          <span className={'gth-card-sub'}>运行记录(最近 6 次)</span>
        </div>
        {tasks.length === 0 ? (
          <EmptyState
            title={'暂无采集任务记录'}
            steps={['启用订阅的「自动采集」或点击「立即采集」后, 这里会展示运行结果']}
          />
        ) : (
          <div className={'gth-list'}>
            <div className={'gth-row gth-row--task is-head'}>
              <span>任务</span>
              <span>状态</span>
              <span>拉取 / 入库</span>
              <span>开始时间</span>
            </div>
            {tasks.map((tk) => (
              <div className={'gth-row gth-row--task'} key={tk.id}>
                <div className={'gth-main'}>
                  <div className={'t'}>
                    订阅 #{tk.subscriptionId} · {tk.trigger === 'auto' ? '自动' : '手动'}
                  </div>
                  {tk.error ? (
                    <div className={'s'} title={tk.error}>
                      {tk.error}
                    </div>
                  ) : null}
                </div>
                <div>
                  {tk.status === 'ok' ? (
                    <Badge tone={'green'}>成功</Badge>
                  ) : tk.status === 'running' ? (
                    <Badge>采集中</Badge>
                  ) : (
                    <Badge tone={'red'}>失败</Badge>
                  )}
                </div>
                <div className={'gth-num'}>
                  {tk.fetched} / {tk.inserted}
                </div>
                <div className={'gth-num'}>{fmt(tk.startedAt)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

// ── 素材仓库 ──
