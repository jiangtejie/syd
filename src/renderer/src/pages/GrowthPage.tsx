import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { toast } from '../stores/toast'
import { confirmAsk } from '../stores/confirmDialog'
import GrowthAiWorkbench from './GrowthAiWorkbench'
import StoresCard from '../components/growth/StoresCard'
import BuzzPanel from '../components/growth/BuzzPanel'
import SkeletonRows from '../components/growth/SkeletonRows'
import { useCountUp } from '../lib/useCountUp'
import { fmtStamp } from '../../../shared/monitorMetrics'
import type {
  GrowthAsset,
  GrowthContentDetailView,
  GrowthContentItem,
  GrowthCrawlTaskView,
  GrowthStats,
  GrowthSubscription,
  GrowthSubscriptionInput
} from '../../../shared/growth'
import './growth.css'

/**
 * 营销增长页: 采集源 / 素材仓库 / 数据服务。
 * 对齐仓库页面规范(page-scroll/page-title/page-card), 无 mock 数据;
 * 空态给引导步骤, 失败给错误条 + 重试, 长任务经 cs:growth:progress 推送。
 */

type GrowthTab = 'provider' | 'sources' | 'warehouse' | 'ai' | 'buzz'

const growthApi = window.api?.cs?.growth

/** 时间一律精确到时分秒(共享实现,别在这里再写一份) */
const fmt = (ts: number | null | undefined): string => fmtStamp(ts)

/** 相对时间(用于「下次采集」) */
const fmtRel = (ts: number | null | undefined): string => {
  if (!ts) return '—'
  const diff = ts - Date.now()
  if (diff <= 0) return '即将执行'
  const min = Math.round(diff / 60000)
  if (min < 60) return min + ' 分钟后'
  const h = Math.round(min / 60)
  if (h < 24) return h + ' 小时后'
  const d = Math.round(h / 24)
  return d + ' 天后'
}

const fmtNum = (n: number): string => (n >= 10000 ? (n / 10000).toFixed(1) + 'w' : String(n))

const TARGET_KIND_LABEL: Record<string, string> = {
  keyword: '关键词',
  account: '账号/竞品',
  topic: '话题',
  rank: '榜单'
}

const ORIGIN_LABEL: Record<string, string> = {
  xhs: '小红书',
  douyin: '抖音',
  self: '自有',
  manual: '手工'
}

const USAGE_LABEL: Record<string, string> = {
  ref: '内部参考',
  own: '自有素材',
  licensed: '已授权'
}

const VENDOR_PRESETS = ['chanmama', 'newhong', 'huitun', 'juliangshu', 'feigua']

// ── 通用小组件 ──

interface SwitchProps {
  checked: boolean
  onChange: (v: boolean) => void
  label?: string
  disabled?: boolean
  title?: string
}

/** 样式化开关(checkbox 视觉层) */
function Switch({ checked, onChange, label, disabled, title }: SwitchProps): React.JSX.Element {
  return (
    <label className={'gth-switch' + (disabled ? ' is-disabled' : '')} title={title}>
      <input
        type={'checkbox'}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className={'track'} />
      {label ? <span>{label}</span> : null}
    </label>
  )
}

type BadgeTone = 'default' | 'green' | 'red' | 'amber' | 'gray'

interface BadgeProps {
  tone?: BadgeTone
  title?: string
  children: React.ReactNode
}

function Badge({ tone = 'default', title, children }: BadgeProps): React.JSX.Element {
  return (
    <span className={'gth-badge' + (tone === 'default' ? '' : ' ' + tone)} title={title}>
      {children}
    </span>
  )
}

/**
 * 防抖检索框: 输入状态留在组件内部(父级不随每次按键重渲染),
 * 停止输入 300ms 或回车后才把值交给父级去查询。
 */
function SearchInput({
  value,
  onApply,
  placeholder,
  maxWidth = 240
}: {
  value: string
  onApply: (v: string) => void
  placeholder: string
  maxWidth?: number
}): React.JSX.Element {
  const [draft, setDraft] = useState(value)

  // 外部重置(如「清除筛选」)时同步回输入框
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 外部值变化同步输入框
    setDraft(value)
  }, [value])

  // 停止输入 300ms 后自动检索
  useEffect(() => {
    if (draft.trim() === value.trim()) return
    const timer = window.setTimeout(() => onApply(draft.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [draft, value, onApply])

  return (
    <input
      className={'gth-input'}
      style={{ maxWidth }}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onApply(draft.trim())
      }}
    />
  )
}

interface EmptyStateProps {
  title: string
  steps?: string[]
  extra?: React.ReactNode
}

function EmptyState({ title, steps, extra }: EmptyStateProps): React.JSX.Element {
  return (
    <div className={'gth-empty'}>
      <div>{title}</div>
      {steps && steps.length > 0 ? (
        <div className={'steps'}>
          {steps.map((s, i) => (
            <div className={'step'} key={s}>
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

interface ErrBarProps {
  msg: string
  onRetry?: () => void
}

function ErrBar({ msg, onRetry }: ErrBarProps): React.JSX.Element {
  return (
    <div className={'gth-error'}>
      <span className={'msg'} title={msg}>
        {msg}
      </span>
      {onRetry ? (
        <button className={'gth-btn sm'} type={'button'} onClick={onRetry}>
          重试
        </button>
      ) : null}
    </div>
  )
}

// ── 指标与状态 ──

interface StatsBarProps {
  stats: GrowthStats | null
}

/** 指标卡图标(线性 16px) */
function IcMetricBox(): React.JSX.Element {
  return (
    <svg
      width={'16'}
      height={'16'}
      viewBox={'0 0 24 24'}
      fill={'none'}
      stroke={'currentColor'}
      strokeWidth={'1.8'}
    >
      <path d={'M3 8.5 12 3.5l9 5v7L12 20.5l-9-5z'} />
      <path d={'M12 12.2 21 7.4M12 12.2v8.3M12 12.2 3 7.4'} />
    </svg>
  )
}
function IcMetricRss(): React.JSX.Element {
  return (
    <svg
      width={'16'}
      height={'16'}
      viewBox={'0 0 24 24'}
      fill={'none'}
      stroke={'currentColor'}
      strokeWidth={'1.8'}
    >
      <path d={'M5 11a8 8 0 0 1 8 8'} />
      <path d={'M5 5a14 14 0 0 1 14 14'} />
      <circle cx={'5.4'} cy={'18.6'} r={'1.4'} fill={'currentColor'} stroke={'none'} />
    </svg>
  )
}
function IcMetricMedia(): React.JSX.Element {
  return (
    <svg
      width={'16'}
      height={'16'}
      viewBox={'0 0 24 24'}
      fill={'none'}
      stroke={'currentColor'}
      strokeWidth={'1.8'}
    >
      <rect x={'3'} y={'4'} width={'18'} height={'16'} rx={'2.5'} />
      <circle cx={'8.6'} cy={'9.6'} r={'1.6'} />
      <path d={'m4 17.5 4.6-4.2 3.4 3 3.2-2.6L20 17.5'} />
    </svg>
  )
}
function IcMetricPlug(): React.JSX.Element {
  return (
    <svg
      width={'16'}
      height={'16'}
      viewBox={'0 0 24 24'}
      fill={'none'}
      stroke={'currentColor'}
      strokeWidth={'1.8'}
    >
      <path d={'M9 3v5M15 3v5'} />
      <path d={'M6.5 8h11v3.2a5.5 5.5 0 0 1-11 0z'} />
      <path d={'M12 16.7V21'} />
    </svg>
  )
}

function StatsBar({ stats }: StatsBarProps): React.JSX.Element {
  const contentCount = useCountUp(stats ? stats.contentCount : null)
  const subCount = useCountUp(stats ? stats.subscriptionCount : null)
  const assetCount = useCountUp(stats ? stats.assetCount : null)
  return (
    <>
      <div className={'gth-cards'}>
        <div className={'page-card gth-metric'}>
          <span className={'gth-metric-ic'}>
            <IcMetricBox />
          </span>
          <div className={'gth-metric-num'}>{contentCount ?? '—'}</div>
          <div className={'gth-metric-label'}>仓库素材</div>
        </div>
        <div className={'page-card gth-metric tone-blue'}>
          <span className={'gth-metric-ic'}>
            <IcMetricRss />
          </span>
          <div className={'gth-metric-num'}>{subCount ?? '—'}</div>
          <div className={'gth-metric-label'}>采集订阅</div>
        </div>
        <div className={'page-card gth-metric tone-violet'}>
          <span className={'gth-metric-ic'}>
            <IcMetricMedia />
          </span>
          <div className={'gth-metric-num'}>{assetCount ?? '—'}</div>
          <div className={'gth-metric-label'}>媒体文件</div>
        </div>
        <div className={'page-card gth-metric tone-amber'}>
          <span className={'gth-metric-ic'}>
            <IcMetricPlug />
          </span>
          <div className={'gth-metric-num' + (stats && !stats.providerConfigured ? ' muted' : '')}>
            {stats ? stats.provider || '未接入' : '—'}
          </div>
          <div className={'gth-metric-label'}>数据服务商</div>
        </div>
      </div>
    </>
  )
}

// ── 数据服务配置 ──

function ProviderPanel({ onChanged }: { onChanged: () => void }): React.JSX.Element {
  const [provider, setProvider] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [autoEnabled, setAutoEnabled] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!growthApi) return
    let alive = true
    growthApi.configGet().then((res) => {
      if (!alive) return
      if (res.ok) {
        setProvider(res.provider ?? '')
        setApiKey(res.providerApiKey ?? '')
        setAutoEnabled(res.autoEnabled ?? false)
      }
      setLoaded(true)
    })
    return () => {
      alive = false
    }
  }, [])

  const save = async (): Promise<void> => {
    if (!growthApi) return
    if (!provider.trim()) {
      toast.error('请填写数据服务商标识')
      return
    }
    setSaving(true)
    try {
      const p1 = await growthApi.configSet('provider', provider)
      if (!p1.ok) {
        toast.error(p1.error || '保存失败')
        return
      }
      const p2 = await growthApi.configSet('providerApiKey', apiKey)
      if (!p2.ok) {
        toast.error(p2.error || '保存失败')
        return
      }
      const p3 = await growthApi.configSet('autoEnabled', autoEnabled ? '1' : '0')
      if (!p3.ok) toast.error(p3.error || '保存失败')
      else {
        toast.success('数据服务配置已保存')
        onChanged()
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={'page-card gth-card'}>
      <div className={'gth-card-head'}>
        <span className={'gth-card-title'}>第三方数据服务商</span>
        <span className={'gth-card-sub'}>
          <Badge tone={loaded ? (provider ? 'green' : 'gray') : 'gray'}>
            {loaded ? (provider ? '已配置' : '未配置') : '加载中…'}
          </Badge>
        </span>
      </div>
      <div className={'gth-form-grid'}>
        <div className={'gth-field'}>
          <span className={'gth-field-label'}>
            供应商标识<span className={'req'}>*</span>
          </span>
          <input
            className="gth-input"
            list={'gth-vendors'}
            value={provider}
            placeholder={'选择或输入, 如 chanmama / newhong'}
            onChange={(e) => setProvider(e.target.value)}
          />
          <datalist id={'gth-vendors'}>
            {VENDOR_PRESETS.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
          <span className={'gth-field-hint'}>
            适配器按此标识加载(Phase 1 提供); 常见: {VENDOR_PRESETS.slice(0, 3).join(' / ')} 等
          </span>
        </div>
        <div className={'gth-field'}>
          <span className={'gth-field-label'}>API Key</span>
          <span className={'gth-key-wrap'}>
            <input
              className={'gth-input'}
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              placeholder={'数据服务订阅后获取'}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <button className={'gth-key-eye'} type={'button'} onClick={() => setShowKey((v) => !v)}>
              {showKey ? '隐藏' : '显示'}
            </button>
          </span>
          <span className={'gth-field-hint'}>safeStorage 加密后落盘, 只在本机解密使用</span>
        </div>
        <div className={'gth-field'}>
          <span className={'gth-field-label'}>自动采集总开关</span>
          <div style={{ height: 30, display: 'flex', alignItems: 'center' }}>
            <Switch
              checked={autoEnabled}
              onChange={setAutoEnabled}
              label={autoEnabled ? '开启: 按订阅间隔自动拉取' : '关闭: 仅手动/链接入库'}
            />
          </div>
          <span className={'gth-field-hint'}>心跳 30s; 建议配置并测试成功后开启</span>
        </div>
        <div className={'gth-field'}>
          <span className={'gth-field-label'}>&nbsp;</span>
          <button
            className={'gth-btn primary'}
            type={'button'}
            disabled={saving || !loaded}
            onClick={() => void save()}
          >
            {saving ? '保存中…' : '保存配置'}
          </button>
        </div>
      </div>
      <div className={'gth-card-note'}>
        Phase 0 说明: 当前为本地骨架期, 供应商适配器接入后此处保存的标识与 Key 将直接生效;
        在此之前可先用「素材仓库」页粘贴小红书/抖音分享链接或口令入库, 不受数据服务影响。
      </div>
    </div>
  )
}

// ── 采集源管理 ──

interface SubFormState {
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

function SourcesPanel({ onChanged }: { onChanged: () => void }): React.JSX.Element {
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

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 挂载时拉取一次订阅与任务(全仓同款模式)
    void load()
  }, [load])

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
          <button className={'gth-btn primary sm'} type={'button'} onClick={openNew}>
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
                className={'gth-input'}
                value={form.name}
                placeholder={'默认同目标'}
                onChange={(e) => setF('name', e.target.value)}
              />
            </div>
            <div className={'gth-field'}>
              <span className={'gth-field-label'}>目标类型</span>
              <select
                className={'gth-select'}
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
                className={'gth-input'}
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
                className={'gth-input'}
                value={form.city}
                placeholder={'如 成都'}
                onChange={(e) => setF('city', e.target.value)}
              />
            </div>
            <div className={'gth-field'}>
              <span className={'gth-field-label'}>业态</span>
              <input
                className={'gth-input'}
                value={form.bizType}
                placeholder={'如 火锅'}
                onChange={(e) => setF('bizType', e.target.value)}
              />
            </div>
            <div className={'gth-field'}>
              <span className={'gth-field-label'}>供应商</span>
              <input
                className={'gth-input'}
                list={'gth-vendors'}
                value={form.vendor}
                placeholder={'如 chanmama'}
                onChange={(e) => setF('vendor', e.target.value)}
              />
            </div>
            <div className={'gth-field'}>
              <span className={'gth-field-label'}>采集间隔</span>
              <select
                className={'gth-select'}
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
                <button className={'gth-btn primary'} type={'button'} onClick={() => void save()}>
                  {editing ? '保存修改' : '创建订阅'}
                </button>
                <button className={'gth-btn'} type={'button'} onClick={() => setFormOpen(false)}>
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
                      className={'gth-btn sm'}
                      type={'button'}
                      disabled={runningId !== null}
                      title={runningId !== null ? '有其他任务进行中' : undefined}
                      onClick={() => void runNow(s)}
                    >
                      {runningId === s.id ? '采集中…' : '立即采集'}
                    </button>
                    <button className={'gth-btn sm'} type={'button'} onClick={() => openEdit(s)}>
                      编辑
                    </button>
                    <button
                      className={'gth-btn sm danger' + (confirmId === s.id ? ' solid' : '')}
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

/** 详情封面预览(本地已下载媒体, 经 ct-growth:// 协议加载; 失败自动隐藏) */
/** 详情 remoteMedia 里的远程视频直链 */
function remoteVideoUrlOf(item: GrowthContentItem): string {
  const rm = item.extra?.['remoteMedia']
  if (rm && typeof rm === 'object') {
    const u = (rm as Record<string, unknown>)['videoUrl']
    if (typeof u === 'string') return u
  }
  return ''
}

/** 详情 remoteMedia 里的远程图源(供未下载提示/来源链接) */
function remoteImageUrlsOf(item: GrowthContentItem): string[] {
  const rm = item.extra?.['remoteMedia']
  if (rm && typeof rm === 'object') {
    const urls = (rm as Record<string, unknown>)['imageUrls']
    if (Array.isArray(urls)) return urls.filter((u): u is string => typeof u === 'string')
  }
  return []
}

interface LightboxProps {
  imgs: GrowthAsset[]
  index: number
  onClose: () => void
  onIndex: (i: number) => void
}

/** 图片灯箱: 全屏查看, ←/→ 翻页, Esc 关闭, 可复制当前图 */
function Lightbox({ imgs, index, onClose, onIndex }: LightboxProps): React.JSX.Element | null {
  const cur = imgs[index] ?? null

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft') onIndex((index - 1 + imgs.length) % imgs.length)
      else if (e.key === 'ArrowRight') onIndex((index + 1) % imgs.length)
    }
    window.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [index, imgs.length, onClose, onIndex])

  if (!cur) return null
  const copy = async (): Promise<void> => {
    if (!growthApi) return
    const res = await growthApi.copyClipboard({ relPath: cur.relPath })
    if (!res.ok) toast.error(res.error || '复制失败')
    else toast.success('当前图已复制, 到微信粘贴即可')
  }

  return (
    <div className="gth-lightbox" onClick={onClose}>
      <img
        className="gth-lightbox-img"
        src={'ct-growth://media/' + cur.relPath}
        alt={'素材图 ' + String(index + 1)}
        onClick={(e) => e.stopPropagation()}
      />
      {imgs.length > 1 ? (
        <>
          <button
            className="gth-lightbox-nav left"
            type="button"
            aria-label="上一张"
            onClick={(e) => {
              e.stopPropagation()
              onIndex((index - 1 + imgs.length) % imgs.length)
            }}
          >
            ‹
          </button>
          <button
            className="gth-lightbox-nav right"
            type="button"
            aria-label="下一张"
            onClick={(e) => {
              e.stopPropagation()
              onIndex((index + 1) % imgs.length)
            }}
          >
            ›
          </button>
          <span className="gth-lightbox-count">
            {String(index + 1)}/{String(imgs.length)}
          </span>
        </>
      ) : null}
      <div className="gth-lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <button className="gth-btn sm" type="button" onClick={() => void copy()}>
          复制当前图
        </button>
        <button className="gth-btn sm" type="button" onClick={onClose}>
          关闭 (Esc)
        </button>
      </div>
    </div>
  )
}

interface MediaGalleryProps {
  assets: GrowthAsset[]
  remoteImageUrls: string[]
  /** 远程视频直链(平台视频素材, 本地不保存视频文件) */
  remoteVideoUrl: string
}

/** 图文画廊: 大图 + 左右翻页 + 缩略图 + 复制当前图(ct-growth:// 本地媒体) */
function MediaGallery({
  assets,
  remoteImageUrls,
  remoteVideoUrl
}: MediaGalleryProps): React.JSX.Element {
  const imgs = assets.filter((a) => (a.kind === 'cover' || a.kind === 'image') && !!a.relPath)
  const [idx, setIdx] = useState(0)
  const [failed, setFailed] = useState(false)
  const [zoom, setZoom] = useState(false)

  // 渲染期钳制: 图片数量变化时索引自动收敛(素材切换由父级 key 重挂载复位)
  const count = imgs.length
  const showIdx = count > 0 ? Math.min(idx, count - 1) : 0
  const cur = count > 0 ? imgs[showIdx] : null

  const copyCurrent = async (): Promise<void> => {
    if (!growthApi || !cur) return
    const res = await growthApi.copyClipboard({ relPath: cur.relPath })
    if (!res.ok) toast.error(res.error || '复制失败')
    else toast.success('当前图已复制, 到微信粘贴即可')
  }

  const localVideo = assets.find((a) => a.kind === 'video' && a.relPath) ?? null

  async function copyRemoteVideo(): Promise<void> {
    if (!growthApi || !remoteVideoUrl) return
    const res = await growthApi.copyClipboard({ text: remoteVideoUrl })
    if (!res.ok) toast.error(res.error || '复制失败')
    else toast.success('视频链接已复制')
  }

  if (imgs.length === 0) {
    return (
      <div>
        {localVideo ? (
          <video
            className="gth-gallery-video"
            src={'ct-growth://media/' + localVideo.relPath}
            controls
            preload="metadata"
          />
        ) : null}
        {!localVideo && remoteVideoUrl ? (
          <div className="gth-empty" style={{ padding: '18px 10px' }}>
            视频素材(本地不保存视频文件)
            <div style={{ marginTop: 8 }}>
              <button className="gth-btn sm" type="button" onClick={() => void copyRemoteVideo()}>
                复制视频链接
              </button>
            </div>
          </div>
        ) : null}
        {!localVideo && !remoteVideoUrl ? (
          <div className="gth-empty" style={{ padding: '26px 10px' }}>
            {remoteImageUrls.length > 0
              ? '该素材的 ' +
                String(remoteImageUrls.length) +
                ' 张源图尚未下载到本地(可删除后重新入库重试下载)'
              : '暂无本地图片: 该素材没有可展示的媒体'}
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div className="gth-gallery">
      <div className="gth-gallery-stage">
        {cur && !failed ? (
          <img
            className="gth-gallery-img clickable"
            decoding="async"
            src={'ct-growth://media/' + cur.relPath}
            alt={'素材图 ' + String(showIdx + 1)}
            loading="lazy"
            title="点击放大查看"
            onClick={() => setZoom(true)}
            onError={() => setFailed(true)}
          />
        ) : (
          <div className="gth-gallery-img-empty">图片加载失败</div>
        )}
        {imgs.length > 1 ? (
          <>
            <button
              className="gth-gallery-nav left"
              type="button"
              aria-label="上一张"
              onClick={() => setIdx((v) => (v - 1 + imgs.length) % imgs.length)}
            >
              ‹
            </button>
            <button
              className="gth-gallery-nav right"
              type="button"
              aria-label="下一张"
              onClick={() => setIdx((v) => (v + 1) % imgs.length)}
            >
              ›
            </button>
            <span className="gth-gallery-count">
              {String(showIdx + 1)}/{String(count)}
            </span>
          </>
        ) : null}
      </div>
      {imgs.length > 1 ? (
        <div className="gth-gallery-thumbs">
          {imgs.map((a, i) => (
            <img
              key={a.id}
              className={'gth-gallery-thumb' + (i === showIdx ? ' is-active' : '')}
              loading={'lazy'}
              decoding={'async'}
              src={'ct-growth://media/' + a.relPath}
              alt="缩略图"
              onClick={() => {
                setIdx(i)
                setFailed(false)
              }}
            />
          ))}
        </div>
      ) : null}
      <button
        className="gth-btn sm gth-gallery-copy"
        type="button"
        disabled={!cur}
        onClick={() => void copyCurrent()}
      >
        复制当前图到剪贴板
      </button>
      {zoom ? (
        <Lightbox
          imgs={imgs}
          index={showIdx}
          onClose={() => setZoom(false)}
          onIndex={(i) => {
            setIdx(i)
            setFailed(false)
          }}
        />
      ) : null}
    </div>
  )
}

const KIND_LABEL: Record<string, string> = {
  image_text: '图文',
  video: '视频',
  unknown: '未知'
}

interface WarehousePanelProps {
  onChanged: () => void
}

/**
 * 链接入库条:输入草稿内聚在自身 state。
 * 若放在 WarehousePanel 顶层,每敲一个字符都会重渲染下面 100 行素材表。
 */
const IngestBar = memo(function IngestBar({
  busy,
  inputRef,
  onSubmit
}: {
  busy: boolean
  inputRef: React.RefObject<HTMLInputElement | null>
  onSubmit: (text: string) => Promise<boolean>
}): React.JSX.Element {
  const [value, setValue] = useState('')
  const submit = (): void => {
    const v = value.trim()
    if (!v || busy) return
    void onSubmit(v).then((ok) => {
      if (ok) setValue('') // 失败保留原文,便于修正后重试
    })
  }
  return (
    <>
      <input
        ref={inputRef}
        className={'gth-input'}
        value={value}
        placeholder={'粘贴小红书/抖音分享链接或口令, Enter 入库(自动识别平台与 ID · 去重防重复)'}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
        }}
      />
      <button
        className={'gth-btn primary'}
        type={'button'}
        disabled={busy || !value.trim()}
        onClick={submit}
      >
        {busy ? '解析中…' : '链接入库'}
      </button>
    </>
  )
})

function WarehousePanel({ onChanged }: WarehousePanelProps): React.JSX.Element {
  const PAGE_SIZE = 100
  const [items, setItems] = useState<GrowthContentItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadErr, setLoadErr] = useState('')
  const [keyword, setKeyword] = useState('')
  const [origin, setOrigin] = useState('')
  const [usage, setUsage] = useState('')
  const [status, setStatus] = useState('')
  const [noDecomp, setNoDecomp] = useState(false)
  const [sort, setSort] = useState<'created' | 'score' | 'likes'>('created')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [busyIngest, setBusyIngest] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [batchBusy, setBatchBusy] = useState(false)
  const [detailId, setDetailId] = useState<number | null>(null)
  const [detail, setDetail] = useState<GrowthContentDetailView | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [patchBusy, setPatchBusy] = useState(false)
  const [noteDraft, setNoteDraft] = useState('')
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null)
  const reqRef = useRef(0)
  /** 已加载列表的同步镜像: 供分页游标使用, 避免把 items.length 放进 load 依赖导致重置循环 */
  const itemsRef = useRef<GrowthContentItem[]>([])
  const ingestRef = useRef<HTMLInputElement | null>(null)
  const detailRef = useRef<HTMLDivElement | null>(null)

  /** 拉取素材: reset=true 覆盖(筛选/排序/首载), false 追加下一页 */
  const load = useCallback(
    async (reset = false): Promise<void> => {
      if (!growthApi) return
      const seq = ++reqRef.current
      if (reset) setLoading(true)
      else setLoadingMore(true)
      setLoadErr('')
      try {
        const offset = reset ? 0 : itemsRef.current.length
        const filter: Record<string, unknown> = { limit: PAGE_SIZE, offset }
        const k = keyword.trim()
        if (k) filter.keyword = k
        if (origin) filter.origin = origin
        if (usage) filter.usage = usage
        if (status) filter.status = status
        if (noDecomp) filter.noDecomp = true
        if (sort !== 'created') filter.sort = sort
        const res = await growthApi.listContent(filter as never)
        if (seq !== reqRef.current) return
        if (!res.ok) {
          setLoadErr(res.error || '读取素材失败')
          return
        }
        const page = res.items ?? []
        const next = reset ? page : itemsRef.current.concat(page)
        itemsRef.current = next
        setItems(next)
        setTotal(res.total ?? page.length)
      } catch (e) {
        if (seq === reqRef.current) setLoadErr(e instanceof Error ? e.message : '读取素材失败')
      } finally {
        if (seq === reqRef.current) {
          setLoading(false)
          setLoadingMore(false)
        }
      }
    },
    [keyword, origin, usage, status, noDecomp, sort]
  )

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 筛选/排序变化与首载统一重拉(全仓同款模式)
    void load(true)
  }, [load])

  /** 强制重拉详情: 不走 openDetail 的「同一行再点收起」逻辑 */
  const refreshDetail = async (id: number): Promise<void> => {
    if (!growthApi) return
    try {
      const res = await growthApi.getContent(id)
      if (res.ok && res.item) {
        const item = res.item as GrowthContentDetailView
        setDetail({ ...item, remixOutputs: item.remixOutputs ?? [], metrics: item.metrics ?? [] })
        setNoteDraft(item.note ?? '')
      }
    } catch {
      /* 详情刷新失败不影响列表主流程 */
    }
  }

  const hasMore = items.length < total

  const openDetail = async (id: number): Promise<void> => {
    if (!growthApi) return
    if (detailId === id) {
      setDetailId(null)
      setDetail(null)
      return
    }
    setDetailId(id)
    setDetail(null)
    setDetailLoading(true)
    try {
      const res = await growthApi.getContent(id)
      if (!res.ok) {
        toast.error(res.error || '读取详情失败')
        return
      }
      if (res.item) {
        // 防御: 兼容旧主进程返回(可能缺 remixOutputs/metrics 字段)
        const item = res.item as GrowthContentDetailView
        setDetail({ ...item, remixOutputs: item.remixOutputs ?? [], metrics: item.metrics ?? [] })
        setNoteDraft(item.note ?? '')
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '读取详情失败')
    } finally {
      setDetailLoading(false)
      // 详情在列表下方: 打开后滚动定位, 避免用户找不到
      setTimeout(
        () => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
        80
      )
    }
  }

  const toggleSelect = (id: number): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const allSelected = items.length > 0 && items.every((it) => selected.has(it.id))

  const toggleAll = (): void => {
    setSelected(allSelected ? new Set() : new Set(items.map((it) => it.id)))
  }

  const batchApply = async (patch: { usage?: string; status?: string }): Promise<void> => {
    if (!growthApi || selected.size === 0) return
    setBatchBusy(true)
    try {
      const res = await growthApi.batchPatch(Array.from(selected), patch)
      if (!res.ok) {
        toast.error(res.error || '批量更新失败')
        return
      }
      toast.success('已更新 ' + String(res.updated ?? 0) + ' 条')
      setSelected(new Set())
      void load(true)
    } finally {
      setBatchBusy(false)
    }
  }

  const batchRemove = async (): Promise<void> => {
    if (!growthApi || selected.size === 0) return
    const okDel = await confirmAsk({
      title: '批量删除素材',
      message: '将删除选中的 ' + String(selected.size) + ' 条素材记录(本地图片文件保留)。',
      confirmText: '删除',
      danger: true
    })
    if (!okDel) return
    setBatchBusy(true)
    try {
      const res = await growthApi.batchRemove(Array.from(selected))
      if (!res.ok) {
        toast.error(res.error || '批量删除失败')
        return
      }
      toast.success('已删除 ' + String(res.removed ?? 0) + ' 条')
      setSelected(new Set())
      itemsRef.current = []
      if (detailId && selected.has(detailId)) {
        setDetailId(null)
        setDetail(null)
      }
      void load(true)
      onChanged()
    } finally {
      setBatchBusy(false)
    }
  }

  const uploadLocal = async (): Promise<void> => {
    if (!growthApi) return
    setUploading(true)
    try {
      const res = await growthApi.uploadLocal()
      if (!res.ok) {
        if (res.error !== '已取消选择') toast.error(res.error || '导入失败')
        return
      }
      toast.success(
        '已导入 ' +
          String(res.added ?? 0) +
          ' 个文件' +
          (res.skipped && res.skipped.length > 0
            ? '(跳过 ' + String(res.skipped.length) + ' 个)'
            : '')
      )
      void load(true)
      onChanged()
    } finally {
      setUploading(false)
    }
  }

  const redownload = async (id: number): Promise<void> => {
    if (!growthApi) return
    setPatchBusy(true)
    try {
      const res = await growthApi.redownloadMedia(id)
      if (!res.ok) {
        toast.error(res.error || '重新下载失败')
        return
      }
      toast.success(
        '已重新下载 ' +
          String(res.added ?? 0) +
          ' 张' +
          ((res.failed ?? 0) > 0 ? ', 失败 ' + String(res.failed) + ' 张' : '')
      )
      await refreshDetail(id)
      void load(true)
      onChanged()
    } finally {
      setPatchBusy(false)
    }
  }

  const exportPkg = async (id: number): Promise<void> => {
    if (!growthApi) return
    setPatchBusy(true)
    try {
      const res = await growthApi.exportPackage(id)
      if (!res.ok) {
        if (res.error !== '已取消导出') toast.error(res.error || '导出失败')
        return
      }
      toast.success('发布包已导出(' + String(res.files ?? 0) + ' 个文件)')
      const openFolder = window.api?.cs?.export?.openFolder
      if (res.dir && openFolder) void openFolder(res.dir)
    } finally {
      setPatchBusy(false)
    }
  }

  const ingestLink = useCallback(
    async (text: string): Promise<boolean> => {
      const link = text.trim()
      if (!growthApi || !link) return false
      setBusyIngest(true)
      try {
        const res = await growthApi.ingestLink(link)
        if (!res.ok) {
          toast.error(res.error || '入库失败')
          return false
        }
        toast.success(res.existed ? '该链接已入库(去重命中)' : '入库成功')
        void load(true)
        onChanged()
        return true
      } catch (e) {
        toast.error(e instanceof Error ? e.message : '入库失败')
        return false
      } finally {
        setBusyIngest(false)
      }
    },
    [load, onChanged]
  )

  const patch = async (
    id: number,
    patchData: { usage?: string; status?: string; note?: string }
  ): Promise<void> => {
    if (!growthApi) return
    setPatchBusy(true)
    try {
      const res = await growthApi.patchContent(id, patchData)
      if (!res.ok) {
        toast.error(res.error || '更新失败')
        return
      }
      toast.success('已更新')
      await refreshDetail(id)
      void load(true)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '更新失败')
    } finally {
      setPatchBusy(false)
    }
  }

  const removeItem = async (id: number): Promise<void> => {
    if (confirmRemove !== id) {
      setConfirmRemove(id)
      setTimeout(() => setConfirmRemove((v) => (v === id ? null : v)), 2500)
      return
    }
    if (!growthApi) return
    const res = await growthApi.removeContent(id)
    if (!res.ok) toast.error(res.error || '删除失败')
    else {
      toast.success('素材已删除')
      onChanged()
    }
    setConfirmRemove(null)
    setDetailId(null)
    setDetail(null)
    setSelected((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    void load(true)
  }

  const filterActive = !!keyword.trim() || !!origin || !!usage

  const rowTitle = (it: GrowthContentItem): string =>
    it.title || (it.text ? it.text.slice(0, 80) : it.note || '(无标题素材)')

  return (
    <>
      <div className={'gth-ingest'}>
        <IngestBar busy={busyIngest} inputRef={ingestRef} onSubmit={ingestLink} />
        <button
          className={'gth-btn'}
          type={'button'}
          disabled={uploading}
          title={'导入门店自有图片/视频(不进公域, 供爆改使用)'}
          onClick={() => void uploadLocal()}
        >
          {uploading ? '导入中…' : '上传本地素材'}
        </button>
      </div>

      <div className={'page-card gth-card'}>
        <div className={'gth-card-head'}>
          <span className={'gth-card-title'}>素材列表</span>
          <span className={'gth-card-sub'}>
            共 {total} 条{items.length < total ? ' · 已加载 ' + String(items.length) : ''} ·
            互动=赞/藏/评/转
          </span>
        </div>
        <div className={'gth-btn-row'} style={{ marginBottom: 10 }}>
          <SearchInput value={keyword} onApply={setKeyword} placeholder={'标题/正文/作者 检索'} />
          <select
            className={'gth-select'}
            style={{ width: 120 }}
            value={origin}
            onChange={(e) => setOrigin(e.target.value)}
          >
            <option value={''}>全部平台</option>
            <option value={'xhs'}>小红书</option>
            <option value={'douyin'}>抖音</option>
            <option value={'self'}>自有</option>
            <option value={'manual'}>手工</option>
          </select>
          <select
            className={'gth-select'}
            style={{ width: 120 }}
            value={usage}
            onChange={(e) => setUsage(e.target.value)}
          >
            <option value={''}>全部用途</option>
            <option value={'ref'}>内部参考</option>
            <option value={'own'}>自有素材</option>
            <option value={'licensed'}>已授权</option>
          </select>
          <select
            className={'gth-select'}
            style={{ width: 120 }}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value={''}>全部状态</option>
            <option value={'new'}>新入库</option>
            <option value={'ready'}>可爆改</option>
            <option value={'used'}>已爆改/已用</option>
            <option value={'archived'}>已归档</option>
          </select>
          <select
            className={'gth-select'}
            style={{ width: 120 }}
            value={sort}
            onChange={(e) => setSort(e.target.value as 'created' | 'score' | 'likes')}
          >
            <option value={'created'}>最新入库</option>
            <option value={'score'}>爆款分优先</option>
            <option value={'likes'}>点赞最多</option>
          </select>
          <button
            className={'gth-chip' + (noDecomp ? ' is-on' : '')}
            type={'button'}
            onClick={() => setNoDecomp((v) => !v)}
          >
            仅未拆解
          </button>
          {filterActive ? (
            <button
              className={'gth-btn sm'}
              type={'button'}
              onClick={() => {
                setKeyword('')
                setOrigin('')
                setUsage('')
                setStatus('')
                setNoDecomp(false)
              }}
            >
              清除筛选
            </button>
          ) : null}
        </div>
        {selected.size > 0 ? (
          <div className={'gth-batchbar'}>
            <span>已选 {selected.size} 条</span>
            <select
              className={'gth-select'}
              style={{ width: 130 }}
              value={''}
              disabled={batchBusy}
              onChange={(e) => {
                if (e.target.value) void batchApply({ usage: e.target.value })
              }}
            >
              <option value={''}>批量改用途…</option>
              <option value={'ref'}>内部参考</option>
              <option value={'own'}>自有素材</option>
              <option value={'licensed'}>已授权</option>
            </select>
            <select
              className={'gth-select'}
              style={{ width: 130 }}
              value={''}
              disabled={batchBusy}
              onChange={(e) => {
                if (e.target.value) void batchApply({ status: e.target.value })
              }}
            >
              <option value={''}>批量改状态…</option>
              <option value={'new'}>新入库</option>
              <option value={'ready'}>可爆改</option>
              <option value={'used'}>已爆改/已用</option>
              <option value={'archived'}>已归档</option>
            </select>
            <button
              className={'gth-btn sm danger'}
              type={'button'}
              disabled={batchBusy}
              onClick={() => void batchRemove()}
            >
              批量删除
            </button>
            <button className={'gth-btn sm'} type={'button'} onClick={() => setSelected(new Set())}>
              取消选择
            </button>
          </div>
        ) : null}
        {loadErr ? <ErrBar msg={loadErr} onRetry={() => void load(true)} /> : null}
        {loading ? (
          <SkeletonRows rows={7} cols={2} />
        ) : items.length === 0 ? (
          filterActive ? (
            <EmptyState
              title={'没有符合筛选条件的素材'}
              steps={['换个关键词, 或点击「清除筛选」查看全部']}
              extra={
                <button
                  className={'gth-btn sm'}
                  type={'button'}
                  onClick={() => {
                    setKeyword('')
                    setOrigin('')
                    setUsage('')
                    setStatus('')
                    setNoDecomp(false)
                  }}
                >
                  清除筛选
                </button>
              }
            />
          ) : (
            <EmptyState
              title={'素材仓库还是空的'}
              steps={[
                '粘贴小红书/抖音分享链接或口令, 或点「上传本地素材」导入门店实拍',
                '到「AI 工作台」点「+ 新建」选这条素材, 与 AI 对话逐项爆改成品牌文案',
                '在「采集源」页配置订阅, 由数据服务定时批量拉取爆款素材'
              ]}
              extra={
                <button
                  className={'gth-btn sm'}
                  type={'button'}
                  onClick={() => ingestRef.current?.focus()}
                >
                  去粘贴入库
                </button>
              }
            />
          )
        ) : (
          <div className={'gth-list'}>
            <div className={'gth-row gth-row--item is-head'}>
              <span>
                <input
                  type={'checkbox'}
                  checked={allSelected}
                  onChange={toggleAll}
                  title={'全选当前页'}
                />
              </span>
              <span>标题 / 内容</span>
              <span>平台 / 形态</span>
              <span className={'gth-num'}>互动(赞/藏/评/转)</span>
              <span>入库时间</span>
              <span>爆款分</span>
              <span className={'gth-col-right'}>用途</span>
            </div>
            {items.map((it, i) => (
              <div
                className={
                  'gth-row gth-row--item clickable' + (detailId === it.id ? ' is-active' : '')
                }
                key={it.id}
                style={{ '--i': i } as React.CSSProperties}
                onClick={() => void openDetail(it.id)}
              >
                <span onClick={(e) => e.stopPropagation()}>
                  <input
                    type={'checkbox'}
                    checked={selected.has(it.id)}
                    onChange={() => toggleSelect(it.id)}
                    title={'选中以批量操作'}
                  />
                </span>
                <div className={'gth-main'}>
                  <div className={'t'}>
                    <span className={'txt'} title={rowTitle(it)}>
                      {rowTitle(it)}
                    </span>
                  </div>
                  <div className={'s'}>
                    {[it.authorName, it.tags.slice(0, 3).join(', ')].filter(Boolean).join(' · ') ||
                      '—'}
                  </div>
                </div>
                <div>
                  <Badge>
                    {ORIGIN_LABEL[it.origin] ?? it.origin} · {KIND_LABEL[it.kind] ?? it.kind}
                  </Badge>
                </div>
                <div className={'gth-num'}>
                  {fmtNum(it.interactions.likes)}/{fmtNum(it.interactions.collects)}/
                  {fmtNum(it.interactions.comments)}/{fmtNum(it.interactions.shares)}
                </div>
                <div className={'gth-num'}>{fmt(it.createdAt)}</div>
                <div className={'gth-num'}>{it.score > 0 ? it.score : '—'}</div>
                <div className={'gth-col-right'}>
                  <Badge tone={it.usage === 'ref' ? 'gray' : 'green'}>
                    {USAGE_LABEL[it.usage] ?? it.usage}
                  </Badge>
                </div>
              </div>
            ))}
            {hasMore ? (
              <div className={'gth-more'}>
                <button
                  className={'gth-btn'}
                  type={'button'}
                  disabled={loadingMore}
                  onClick={() => void load(false)}
                >
                  {loadingMore
                    ? '加载中…'
                    : '加载更多(还有 ' + String(total - items.length) + ' 条)'}
                </button>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {detailLoading ? (
        <div className={'page-card gth-card gth-detail-loading'}>加载详情…</div>
      ) : null}
      {detail ? (
        <div className={'gth-detail'} ref={detailRef}>
          <div className={'page-card gth-card'}>
            <div className={'gth-card-head'}>
              <span className={'gth-card-title'}>图文</span>
              <span className={'gth-card-sub'}>
                {
                  (detail.assets ?? []).filter((a) => a.kind === 'cover' || a.kind === 'image')
                    .length
                }{' '}
                张
              </span>
            </div>
            <MediaGallery
              key={'gallery-' + String(detail.id)}
              assets={detail.assets ?? []}
              remoteImageUrls={remoteImageUrlsOf(detail)}
              remoteVideoUrl={remoteVideoUrlOf(detail)}
            />
          </div>
          <div className={'page-card gth-card gth-kv-card'}>
            <div className={'gth-card-head'}>
              <span className={'gth-card-title'}>素材详情</span>
              <span className={'gth-card-sub'}>#{detail.id}</span>
              <span className={'gth-detail-btns'}>
                <button
                  className={'gth-btn sm'}
                  type={'button'}
                  disabled={patchBusy}
                  onClick={() => void exportPkg(detail.id)}
                >
                  导出发布包
                </button>
                <button
                  className={'gth-btn sm'}
                  type={'button'}
                  disabled={patchBusy}
                  title={'本地图片缺失时按源链接重新下载'}
                  onClick={() => void redownload(detail.id)}
                >
                  重下图片
                </button>
                <button
                  className={'gth-btn sm danger' + (confirmRemove === detail.id ? ' solid' : '')}
                  type={'button'}
                  disabled={patchBusy}
                  onClick={() => void removeItem(detail.id)}
                >
                  {confirmRemove === detail.id ? '确认删除?' : '删除'}
                </button>
                <button
                  className={'gth-btn sm'}
                  type={'button'}
                  title={'收起详情'}
                  onClick={() => {
                    setDetailId(null)
                    setDetail(null)
                  }}
                >
                  收起
                </button>
              </span>
            </div>
            <dl className={'gth-kv'}>
              <dt>来源</dt>
              <dd>
                <Badge>
                  {ORIGIN_LABEL[detail.origin] ?? detail.origin} ·{' '}
                  {KIND_LABEL[detail.kind] ?? detail.kind}
                </Badge>
                {detail.platformItemId ? (
                  <span className={'gth-num'}> ID {detail.platformItemId}</span>
                ) : null}
              </dd>
              <dt>标题</dt>
              <dd>{detail.title || '(无)'}</dd>
              {detail.text ? (
                <>
                  <dt>正文</dt>
                  <dd>
                    {detail.text.slice(0, 240)}
                    {detail.text.length > 240 ? '…' : ''}
                  </dd>
                </>
              ) : null}
              {detail.authorName ? (
                <>
                  <dt>作者</dt>
                  <dd>
                    {detail.authorName}
                    {detail.authorId ? ' (' + detail.authorId + ')' : null}
                  </dd>
                </>
              ) : null}
              {detail.link ? (
                <>
                  <dt>链接</dt>
                  <dd>
                    <a className={'link'} href={detail.link} target={'_blank'} rel={'noreferrer'}>
                      {detail.link}
                    </a>
                  </dd>
                </>
              ) : null}
              <dt>入库 / 发布</dt>
              <dd>
                {fmt(detail.createdAt)}
                {detail.publishedAt ? ' · 发布 ' + fmt(detail.publishedAt) : ' · 未获取发布时间'}
              </dd>
              <dt>互动</dt>
              <dd className={'gth-num'}>
                赞 {fmtNum(detail.interactions.likes)} · 藏 {fmtNum(detail.interactions.collects)} ·
                评 {fmtNum(detail.interactions.comments)} · 转 {fmtNum(detail.interactions.shares)}
              </dd>
              {detail.tags.length > 0 ? (
                <>
                  <dt>标签</dt>
                  <dd>{detail.tags.join(', ')}</dd>
                </>
              ) : null}
              <dt>媒体 / 拆解</dt>
              <dd>
                {detail.assets.length} 个文件 ·{' '}
                {detail.decomp ? (
                  <Badge tone={'green'}>已拆解</Badge>
                ) : (
                  <Badge tone={'gray'}>待拆解</Badge>
                )}
              </dd>
            </dl>
            <div className={'gth-ops'}>
              <div className={'gth-ops-row'}>
                <label className={'gth-ops-fld'}>
                  <span className={'lb'}>用途</span>
                  <select
                    className={'gth-select'}
                    value={detail.usage}
                    disabled={patchBusy}
                    onChange={(e) => void patch(detail.id, { usage: e.target.value })}
                  >
                    <option value={'ref'}>内部参考</option>
                    <option value={'own'}>自有素材</option>
                    <option value={'licensed'}>已授权</option>
                  </select>
                </label>
                <label className={'gth-ops-fld'}>
                  <span className={'lb'}>状态</span>
                  <select
                    className={'gth-select'}
                    value={detail.status}
                    disabled={patchBusy}
                    onChange={(e) => void patch(detail.id, { status: e.target.value })}
                  >
                    <option value={'new'}>新入库</option>
                    <option value={'ready'}>可爆改</option>
                    <option value={'used'}>已爆改/已用</option>
                    <option value={'archived'}>已归档</option>
                  </select>
                </label>
              </div>
              <div className={'gth-ops-row'}>
                <label className={'gth-ops-fld grow'}>
                  <span className={'lb'}>内部备注</span>
                  <textarea
                    className={'gth-input gth-input--area'}
                    rows={2}
                    value={noteDraft}
                    disabled={patchBusy}
                    placeholder={'来源说明 / 待补全事项 / 跟进信息'}
                    onChange={(e) => setNoteDraft(e.target.value)}
                  />
                </label>
                <button
                  className={'gth-btn sm'}
                  type={'button'}
                  disabled={patchBusy || noteDraft === detail.note}
                  onClick={() => void patch(detail.id, { note: noteDraft })}
                >
                  {patchBusy ? '保存中…' : '保存备注'}
                </button>
              </div>
              <div className={'gth-ops-hint'}>
                仅内部可见; 来源为「内部参考」的素材只能用于学习分析, 对外发布先到「AI
                工作台」原创化处理。
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}

// ── 页面外壳 ──

const TAB_DESC: Record<GrowthTab, string> = {
  buzz: '门店舆情监控: 跟踪抖音/小红书上的门店相关内容, 结合正文与评论区高赞做情绪评级与根因诊断',
  ai: '任务式爆改工作台: 左边素材任务列表, 右边与 AI 对话逐项改标题/正文/配图, 右侧产出面板点选采用',
  sources: '订阅同城/同行的爆款内容源, 由第三方数据服务定时拉取入库',
  warehouse:
    '本地爆款素材仓库: 粘贴链接入库、检索、打标、批量导出; AI 拆解与爆改在「AI 工作台」进行',
  provider: '第三方数据服务商与自动采集总开关(适配器 Phase 1 接入)'
}

export default function GrowthPage(): React.JSX.Element {
  const [tab, setTab] = useState<GrowthTab>('warehouse')
  const [stats, setStats] = useState<GrowthStats | null>(null)
  /** 从素材仓库跳转 AI 工作台时携带的任务 id */
  const [aiFocusTask, setAiFocusTask] = useState<number | null>(null)

  const loadStats = useCallback((): void => {
    if (!growthApi) return
    growthApi.stats().then((res) => {
      if (res.ok && res.stats) setStats(res.stats)
    })
  }, [])

  useEffect(() => {
    loadStats()
  }, [loadStats])

  useEffect(() => {
    if (!growthApi?.onProgress) return
    const unsub = growthApi.onProgress((p) => {
      if (p.kind === 'crawl') {
        if (p.status === 'done') toast.success('采集完成: ' + p.detail)
        else if (p.status === 'error') toast.error('采集失败: ' + p.detail)
      }
      loadStats()
    })
    return unsub
  }, [loadStats])

  if (!growthApi) {
    return (
      <div className={'page-scroll gth-page'}>
        <h2 className={'page-title'}>营销</h2>
        <div className={'gth-error'}>增长 API 不可用(请在完整应用环境中使用)</div>
      </div>
    )
  }

  return (
    <div className={'page-scroll gth-page'}>
      <div className={'gth-hero'}>
        <div className={'gth-hero-top'}>
          <span className={'gth-hero-logo'}>
            <svg
              width={'19'}
              height={'19'}
              viewBox={'0 0 24 24'}
              fill={'none'}
              stroke={'currentColor'}
              strokeWidth={'1.9'}
              strokeLinecap={'round'}
              strokeLinejoin={'round'}
            >
              <path d={'M4 15.5 9 10l3.4 3.2L20 6'} />
              <path d={'M15.4 6H20v4.6'} />
              <path d={'M4 20h16'} />
            </svg>
          </span>
          <div className={'gth-hero-text'}>
            <h2 className={'page-title'}>营销</h2>
            <div className={'page-subtitle'}>{TAB_DESC[tab]}</div>
          </div>
          <div className={'gth-hero-side'}>
            {stats ? (
              stats.autoEnabled ? (
                <span className={'gth-hero-chip on'} title={'按订阅节奏自动拉取'}>
                  <span className={'dot'} />
                  自动采集运行中
                </span>
              ) : (
                <span className={'gth-hero-chip warn'} title={'到「数据服务」开启总开关'}>
                  <span className={'dot'} />
                  自动采集未开启
                </span>
              )
            ) : null}
            {stats?.lastCrawlAt ? (
              <span className={'gth-hero-chip'}>最近采集 {fmt(stats.lastCrawlAt)}</span>
            ) : null}
            <button className={'gth-btn sm'} type={'button'} onClick={loadStats} title={'刷新指标'}>
              刷新
            </button>
          </div>
        </div>
        <div className={'gth-seg'}>
          {(['warehouse', 'ai', 'buzz', 'sources', 'provider'] as GrowthTab[]).map((k, i) => (
            <button
              key={k}
              type={'button'}
              className={'gth-seg-btn' + (tab === k ? ' is-active' : '')}
              style={{ '--i': i } as React.CSSProperties}
              onClick={() => setTab(k)}
            >
              {k === 'warehouse'
                ? '素材仓库'
                : k === 'ai'
                  ? 'AI 工作台'
                  : k === 'buzz'
                    ? '舆情'
                    : k === 'sources'
                      ? '采集源'
                      : '数据服务'}
            </button>
          ))}
          <span className={'gth-seg-hint'}>AI 工作台 = 任务式爆改(对话驱动)</span>
        </div>
      </div>
      <StatsBar stats={stats} />
      {tab === 'provider' ? (
        <>
          <ProviderPanel onChanged={loadStats} />
          <StoresCard />
        </>
      ) : null}
      {tab === 'sources' ? <SourcesPanel onChanged={loadStats} /> : null}
      {tab === 'warehouse' ? <WarehousePanel onChanged={loadStats} /> : null}
      {tab === 'buzz' ? (
        <BuzzPanel
          onChanged={loadStats}
          onOpenWorkbench={(taskId) => {
            setAiFocusTask(taskId)
            setTab('ai')
          }}
        />
      ) : null}
      {tab === 'ai' ? (
        <GrowthAiWorkbench
          focusTaskId={aiFocusTask}
          onFocusConsumed={() => setAiFocusTask(null)}
          onChanged={loadStats}
        />
      ) : null}
    </div>
  )
}
