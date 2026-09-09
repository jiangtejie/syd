/**
 * 舆情监控面板(营销 → 舆情): 门店舆情总览 + 列表 + 详情诊断 + 评论录入。
 * 数据链路: 粘贴原帖链接 → 解析入库(保留原链接/封面/互动) → 录入评论区高赞 → 智能诊断(规则+模型)。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from '../../stores/toast'
import { confirmAsk } from '../../stores/confirmDialog'
import SkeletonRows from './SkeletonRows'
import { useEscape } from '../../lib/useEscape'
import type {
  GrowthBuzzCommentView,
  GrowthBuzzMentionView,
  GrowthBuzzOverview,
  GrowthBuzzDetailView,
  GrowthBuzzDiagnosisView
} from '../../../../shared/growth'

const api = window.api?.cs?.growthbuzz
const storeApi = window.api?.cs?.growthai

const PLATFORM_LABEL: Record<string, string> = {
  douyin: '抖音',
  xhs: '小红书',
  other: '其他'
}

const SENTIMENT_LABEL: Record<string, string> = {
  positive: '积极',
  neutral: '中性',
  negative: '消极',
  '': '待诊断'
}

const RISK_LABEL: Record<string, string> = {
  high: '高风险',
  medium: '需关注',
  low: '低风险',
  '': '未评级'
}

const STATUS_LABEL: Record<string, string> = {
  new: '待处理',
  reviewing: '处理中',
  replied: '已回应',
  ignored: '已忽略'
}

const STATUS_KEYS: string[] = ['new', 'reviewing', 'replied', 'ignored']

function sentimentClass(s: string): string {
  if (s === 'negative') return 'neg'
  if (s === 'positive') return 'pos'
  if (s === 'neutral') return 'neu'
  return 'none'
}

const fmt = (ts: number | null | undefined): string =>
  ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—'

const fmtNum = (n: number): string => (n >= 10000 ? (n / 10000).toFixed(1) + 'w' : String(n))

const SENTIMENT_TABS: Array<{ key: string; label: string }> = [
  { key: '', label: '全部' },
  { key: 'negative', label: '消极' },
  { key: 'neutral', label: '中性' },
  { key: 'positive', label: '积极' }
]

interface StoreOption {
  id: number
  name: string
  brandName: string
}

export default function BuzzPanel({
  onChanged,
  onOpenWorkbench
}: {
  onChanged?: () => void
  onOpenWorkbench?: (taskId: number) => void
}): React.JSX.Element {
  const [overview, setOverview] = useState<GrowthBuzzOverview | null>(null)
  const [items, setItems] = useState<GrowthBuzzMentionView[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [stores, setStores] = useState<StoreOption[]>([])

  // 筛选
  const [storeId, setStoreId] = useState(0)
  const [platform, setPlatform] = useState('')
  const [sentiment, setSentiment] = useState('')
  const [status, setStatus] = useState('')
  const [keyword, setKeyword] = useState('')
  const [kwDraft, setKwDraft] = useState('')

  // 详情抽屉
  const [detail, setDetail] = useState<GrowthBuzzDetailView | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [cmtDraft, setCmtDraft] = useState('')
  const [noteDraft, setNoteDraft] = useState('')
  const [busy, setBusy] = useState(0)
  const [batchRunning, setBatchRunning] = useState(false)

  // 添加舆情
  const [addOpen, setAddOpen] = useState(false)
  const [addStoreId, setAddStoreId] = useState(0)
  const [addText, setAddText] = useState('')
  const [adding, setAdding] = useState(false)

  /** 请求序号:快速切换筛选时,慢响应不得覆盖后选中的结果(与 GrowthPage 的 reqRef 同款) */
  const loadSeqRef = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    if (!api) return
    const seq = ++loadSeqRef.current
    setLoading(true)
    setError('')
    try {
      const [ov, list] = await Promise.all([
        api.overview(storeId || null),
        api.list({
          storeId: storeId || null,
          platform,
          sentiment,
          status,
          keyword,
          limit: 200
        })
      ])
      if (seq !== loadSeqRef.current) return // 已被更新的筛选覆盖
      if (ov.ok && ov.overview) setOverview(ov.overview)
      else if (!ov.ok) setError(ov.error || '读取舆情概览失败')
      if (list.ok) {
        setItems(list.items ?? [])
        setTotal(list.total ?? 0)
      } else setError(list.error || '读取舆情列表失败')
    } catch (e) {
      if (seq !== loadSeqRef.current) return
      setError(e instanceof Error ? e.message : '读取失败')
    } finally {
      if (seq === loadSeqRef.current) setLoading(false)
    }
  }, [storeId, platform, sentiment, status, keyword])

  const loadStores = useCallback(async (): Promise<void> => {
    if (!storeApi) return
    const res = await storeApi.listStores()
    if (res.ok) setStores((res.stores ?? []) as StoreOption[])
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 挂载时拉取门店一次(全仓同款模式)
    void loadStores()
  }, [loadStores])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 筛选变化与首载统一重拉(全仓同款模式)
    void load()
  }, [load])

  const openDetail = useCallback(async (id: number): Promise<void> => {
    if (!api) return
    setDetailLoading(true)
    const res = await api.detail(id)
    setDetailLoading(false)
    if (!res.ok) {
      toast.error(res.error || '读取详情失败')
      return
    }
    if (!res.mention) {
      toast.error('读取详情失败')
      return
    }
    setDetail({ mention: res.mention, comments: (res.comments ?? []) as GrowthBuzzCommentView[] })
    setNoteDraft(res.mention.note || '')
    setCmtDraft('')
  }, [])

  const closeDetail = useCallback((): void => {
    setDetail(null)
    setCmtDraft('')
    setNoteDraft('')
  }, [])

  const runDiagnose = useCallback(
    async (id: number): Promise<void> => {
      if (!api) return
      setBusy(id)
      const res = await api.diagnose(id, true)
      setBusy(0)
      if (!res.ok) {
        toast.error(res.error || '诊断失败')
        return
      }
      if (!res.diagnosis) {
        toast.error('诊断失败: 模型未返回结果')
        return
      }
      const d: GrowthBuzzDiagnosisView = res.diagnosis
      toast.success(
        '诊断完成: ' +
          (SENTIMENT_LABEL[d.sentiment] ?? d.sentiment) +
          ' ' +
          String(d.finalScore) +
          ' 分 · ' +
          (RISK_LABEL[d.riskLevel] ?? '')
      )
      await load()
      await openDetail(id)
      onChanged?.()
    },
    [load, openDetail, onChanged]
  )

  const patch = useCallback(
    async (id: number, body: Record<string, unknown>): Promise<void> => {
      if (!api) return
      const res = await api.update(id, body)
      if (!res.ok) {
        toast.error(res.error || '更新失败')
        return
      }
      await load()
      await openDetail(id)
    },
    [load, openDetail]
  )

  const removeOne = useCallback(
    async (id: number): Promise<void> => {
      if (!api) return
      const ok = await confirmAsk({
        title: '删除舆情记录',
        message: '删除后该条记录及其评论将一并移除, 是否继续?',
        confirmText: '删除',
        danger: true
      })
      if (!ok) return
      const res = await api.remove(id)
      if (!res.ok) {
        toast.error(res.error || '删除失败')
        return
      }
      toast.success('已删除')
      if (detail?.mention.id === id) closeDetail()
      await load()
      onChanged?.()
    },
    [detail, load, onChanged, closeDetail]
  )

  const submitComments = useCallback(async (): Promise<void> => {
    if (!api || !detail) return
    const raw = cmtDraft.trim()
    if (!raw) {
      toast.error('请粘贴评论区内容')
      return
    }
    setBusy(detail.mention.id)
    const res = await api.addComments({ mentionId: detail.mention.id, raw, source: 'manual' })
    setBusy(0)
    if (!res.ok) {
      toast.error(res.error || '评论录入失败')
      return
    }
    toast.success(
      '已录入 ' +
        String(res.added ?? 0) +
        ' 条评论' +
        (res.skipped ? ', 跳过重复 ' + String(res.skipped) : '')
    )
    setCmtDraft('')
    await load()
    await openDetail(detail.mention.id)
  }, [detail, cmtDraft, load, openDetail])

  const submitAdd = useCallback(async (): Promise<void> => {
    if (!api) return
    const text = addText.trim()
    if (!text) {
      toast.error('请粘贴抖音/小红书链接或分享口令')
      return
    }
    setAdding(true)
    const res = await api.addLink({ storeId: addStoreId || null, text })
    setAdding(false)
    if (!res.ok) {
      toast.error(res.error || '解析入库失败')
      return
    }
    if (res.existed) toast.info('该内容已在监控列表中')
    else if (res.diagnosisError) toast.error('已入库, 但智能诊断失败: ' + res.diagnosisError)
    else toast.success('已入库并完成诊断')
    setAddOpen(false)
    setAddText('')
    await load()
    if (res.id) await openDetail(res.id)
    onChanged?.()
  }, [addStoreId, addText, load, openDetail, onChanged])

  const toWorkbench = useCallback(
    async (id: number): Promise<void> => {
      if (!api) return
      setBusy(id)
      const res = await api.toWorkbench(id)
      setBusy(0)
      if (!res.ok) {
        toast.error(res.error || '创建任务失败')
        return
      }
      toast.success('已创建爆改任务, 正在跳转 AI 工作台…')
      onChanged?.()
      if (res.taskId) onOpenWorkbench?.(res.taskId)
    },
    [onChanged, onOpenWorkbench]
  )

  const runBatch = useCallback(async (): Promise<void> => {
    if (!api) return
    const ids = items
      .filter((m) => !m.diagnosedAt)
      .map((m) => m.id)
      .slice(0, 20)
    if (ids.length === 0) {
      toast.info('没有待诊断的记录')
      return
    }
    setBatchRunning(true)
    const res = await api.diagnoseBatch(ids, true)
    setBatchRunning(false)
    if (!res.ok) {
      toast.error(res.error || '批量诊断失败')
      return
    }
    toast.success(
      '批量诊断完成: 成功 ' +
        String(res.succeeded ?? 0) +
        (res.failed ? ', 失败 ' + String(res.failed) : '')
    )
    await load()
    onChanged?.()
  }, [items, load, onChanged])

  const openUrl = useCallback(async (url: string): Promise<void> => {
    if (!api || !url) return
    const res = await api.openUrl(url)
    if (!res.ok) toast.error(res.error || '打开链接失败')
  }, [])

  const resetFilters = useCallback((): void => {
    setStoreId(0)
    setPlatform('')
    setSentiment('')
    setStatus('')
    setKeyword('')
    setKwDraft('')
  }, [])

  const pendingCount = useMemo(() => items.filter((m) => !m.diagnosedAt).length, [items])

  // Esc 关闭抽屉 / 新增弹窗(回调必须稳定,否则每次渲染都会重挂键盘监听)
  const closeAdd = useCallback((): void => setAddOpen(false), [])
  useEscape(Boolean(detail), closeDetail)
  useEscape(addOpen, closeAdd)
  const hasFilter = Boolean(storeId || platform || sentiment || status || keyword)

  const storeLabel = useMemo(
    () => stores.find((s) => s.id === storeId)?.name || (storeId ? '门店 ' + String(storeId) : ''),
    [stores, storeId]
  )

  const sentimentCount = (key: string): number => {
    if (key === '') return overview?.total ?? 0
    if (key === 'negative') return overview?.negative ?? 0
    if (key === 'neutral') return overview?.neutral ?? 0
    return overview?.positive ?? 0
  }

  if (!api) {
    return <div className={'gth-error'}>舆情 API 不可用(请在完整应用环境中使用)</div>
  }

  return (
    <div className={'gth-buzz'}>
      {/* 概览 */}
      <div className={'gth-buzz-stats'}>
        <div className={'gth-buzz-stat'}>
          <span className={'v'}>{overview?.total ?? 0}</span>
          <span className={'k'}>监控总量</span>
        </div>
        <div className={'gth-buzz-stat pos'}>
          <span className={'v'}>{overview?.positive ?? 0}</span>
          <span className={'k'}>积极</span>
        </div>
        <div className={'gth-buzz-stat neu'}>
          <span className={'v'}>{overview?.neutral ?? 0}</span>
          <span className={'k'}>中性</span>
        </div>
        <div className={'gth-buzz-stat neg'}>
          <span className={'v'}>{overview?.negative ?? 0}</span>
          <span className={'k'}>消极</span>
        </div>
        <div className={'gth-buzz-stat neg'}>
          <span className={'v'}>{overview?.highRisk ?? 0}</span>
          <span className={'k'}>高风险</span>
        </div>
        <div className={'gth-buzz-stat'}>
          <span className={'v'}>{overview?.avgScore ?? 0}</span>
          <span className={'k'}>平均分</span>
        </div>
        <div className={'gth-buzz-stat warn'}>
          <span className={'v'}>{overview?.pending ?? 0}</span>
          <span className={'k'}>待处理</span>
        </div>
      </div>

      {/* 筛选栏 */}
      <div className={'gth-buzz-filters'}>
        <div className={'row'}>
          <label className={'fld'}>
            <span className={'lb'}>门店</span>
            <select
              className={'gth-select'}
              value={storeId}
              onChange={(e) => setStoreId(Number(e.target.value))}
            >
              <option value={0}>全部门店</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name || s.brandName || '门店 ' + String(s.id)}
                </option>
              ))}
            </select>
          </label>

          <label className={'fld'}>
            <span className={'lb'}>平台</span>
            <select
              className={'gth-select'}
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
            >
              <option value={''}>全部平台</option>
              <option value={'douyin'}>抖音</option>
              <option value={'xhs'}>小红书</option>
            </select>
          </label>

          <div className={'fld'}>
            <span className={'lb'}>情绪</span>
            <div className={'gth-buzz-seg'}>
              {SENTIMENT_TABS.map((t) => (
                <button
                  key={t.key || 'all'}
                  type={'button'}
                  className={
                    'seg' + (t.key ? ' ' + t.key : '') + (sentiment === t.key ? ' is-on' : '')
                  }
                  onClick={() => setSentiment(t.key)}
                >
                  {t.label}
                  <b>{sentimentCount(t.key)}</b>
                </button>
              ))}
            </div>
          </div>

          <label className={'fld'}>
            <span className={'lb'}>状态</span>
            <select
              className={'gth-select'}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value={''}>全部状态</option>
              {STATUS_KEYS.map((k) => (
                <option key={k} value={k}>
                  {STATUS_LABEL[k]}
                </option>
              ))}
            </select>
          </label>

          <label className={'fld grow'}>
            <span className={'lb'}>关键词</span>
            <span className={'gth-buzz-search'}>
              <svg viewBox={'0 0 16 16'} width={'13'} height={'13'} aria-hidden={'true'}>
                <circle
                  cx={'6.8'}
                  cy={'6.8'}
                  r={'4.4'}
                  fill={'none'}
                  stroke={'currentColor'}
                  strokeWidth={'1.4'}
                />
                <line
                  x1={'10.2'}
                  y1={'10.2'}
                  x2={'14'}
                  y2={'14'}
                  stroke={'currentColor'}
                  strokeWidth={'1.4'}
                  strokeLinecap={'round'}
                />
              </svg>
              <input
                className={'gth-input'}
                placeholder={'搜索标题 / 正文 / 作者'}
                value={kwDraft}
                onChange={(e) => setKwDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') setKeyword(kwDraft.trim())
                }}
              />
              {kwDraft ? (
                <button
                  className={'clr'}
                  type={'button'}
                  title={'清空关键词'}
                  onClick={() => {
                    setKwDraft('')
                    setKeyword('')
                  }}
                >
                  ✕
                </button>
              ) : null}
            </span>
          </label>
        </div>
        <div className={'summary'}>
          <span>
            共 <b>{total}</b> 条{hasFilter ? ' · 已筛选' : ''}
          </span>
          {storeId ? <span className={'chip'}>{storeLabel}</span> : null}
          {platform ? <span className={'chip'}>{PLATFORM_LABEL[platform] ?? platform}</span> : null}
          {sentiment ? <span className={'chip'}>{SENTIMENT_LABEL[sentiment]}</span> : null}
          {status ? <span className={'chip'}>{STATUS_LABEL[status]}</span> : null}
          {keyword ? <span className={'chip'}>关键词: {keyword}</span> : null}
          {hasFilter ? (
            <button className={'lnk'} type={'button'} onClick={resetFilters}>
              清除筛选
            </button>
          ) : null}
          <div className={'acts'}>
            <button
              className={'gth-btn sm'}
              type={'button'}
              disabled={batchRunning || pendingCount === 0}
              onClick={() => void runBatch()}
            >
              {batchRunning
                ? '诊断中…'
                : '一键诊断待处理' + (pendingCount > 0 ? '(' + String(pendingCount) + ')' : '')}
            </button>
            <button
              className={'gth-btn primary sm'}
              type={'button'}
              onClick={() => setAddOpen(true)}
            >
              + 添加舆情
            </button>
          </div>
        </div>
      </div>

      {error ? (
        <div className={'gth-error'}>
          <span className={'msg'}>{error}</span>
          <button className={'gth-btn sm'} type={'button'} onClick={() => void load()}>
            重试
          </button>
        </div>
      ) : null}

      {/* 列表 */}
      {loading && items.length === 0 ? (
        <SkeletonRows rows={6} cols={2} />
      ) : items.length === 0 ? (
        <div className={'gth-empty'}>
          <div className={'steps'}>
            <div className={'step'}>
              <span className={'no'}>1</span>
              把门店相关的抖音/小红书链接或分享口令粘贴进来(自动解析原帖)
            </div>
            <div className={'step'}>
              <span className={'no'}>2</span>打开详情,
              把评论区高赞评论粘贴进「评论录入」(赞数|作者|内容, 每行一条)
            </div>
            <div className={'step'}>
              <span className={'no'}>3</span>系统按「正文 + 高赞评论」给出情绪评级与根因诊断
            </div>
          </div>
        </div>
      ) : (
        <div className={'gth-buzz-list'}>
          <div className={'gth-buzz-row is-head'}>
            <span />
            <span>内容 / 作者</span>
            <span>互动</span>
            <span>情绪 / 评分</span>
            <span>风险</span>
            <span>评论</span>
            <span>状态</span>
            <span>操作</span>
          </div>
          {items.map((m, i) => (
            <div
              key={m.id}
              className={'gth-buzz-row' + (detail?.mention.id === m.id ? ' is-active' : '')}
              style={{ '--i': i } as React.CSSProperties}
            >
              <span className={'cover'}>
                {m.assets[0] ? (
                  <img
                    src={'ct-growth://media/' + m.assets[0]}
                    alt={''}
                    loading={'lazy'}
                    decoding={'async'}
                  />
                ) : (
                  <span className={'ph'}>{PLATFORM_LABEL[m.platform] ?? m.platform}</span>
                )}
              </span>
              <span className={'main'}>
                <span className={'t'}>
                  <span className={'txt'} title={m.title}>
                    {m.title || '(无标题)'}
                  </span>
                  <span className={'gth-badge gray'}>
                    {PLATFORM_LABEL[m.platform] ?? m.platform}
                  </span>
                  {m.kind === 'video' ? (
                    <span className={'gth-badge gray'}>视频</span>
                  ) : (
                    <span className={'gth-badge gray'}>图文</span>
                  )}
                  {m.storeName ? <span className={'gth-badge'}>{m.storeName}</span> : null}
                </span>
                <span className={'s'}>
                  {m.authorName || '未知作者'} · {fmt(m.createdAt)}
                  {m.diagnosis && typeof m.diagnosis['summary'] === 'string'
                    ? ' · ' + String(m.diagnosis['summary'])
                    : ''}
                </span>
              </span>
              <span className={'num'}>
                赞 {fmtNum(m.interactions.likes)}
                <br />评 {fmtNum(m.interactions.comments)}
              </span>
              <span>
                <span
                  className={
                    'gth-badge ' +
                    (m.sentiment === 'negative'
                      ? 'red'
                      : m.sentiment === 'positive'
                        ? 'green'
                        : 'gray')
                  }
                >
                  {SENTIMENT_LABEL[m.sentiment] ?? '待诊断'}
                </span>
                <span className={'score ' + sentimentClass(m.sentiment)}>
                  {m.diagnosedAt ? (m.score > 0 ? '+' : '') + String(m.score) : '—'}
                </span>
              </span>
              <span
                className={
                  'gth-badge ' +
                  (m.riskLevel === 'high' ? 'red' : m.riskLevel === 'medium' ? 'amber' : 'gray')
                }
              >
                {RISK_LABEL[m.riskLevel] ?? '未评级'}
              </span>
              <span className={'num'}>
                {String(m.commentCount)}
                <br />
                高赞 {String(m.highCommentCount)}
              </span>
              <span className={'gth-badge gray'}>{STATUS_LABEL[m.status] ?? m.status}</span>
              <span className={'gth-actions'}>
                <button
                  className={'gth-btn sm'}
                  type={'button'}
                  onClick={() => void openDetail(m.id)}
                >
                  详情
                </button>
                <button
                  className={'gth-btn sm'}
                  type={'button'}
                  disabled={busy === m.id}
                  onClick={() => void runDiagnose(m.id)}
                >
                  {busy === m.id ? '…' : '诊断'}
                </button>
                <button
                  className={'gth-btn sm'}
                  type={'button'}
                  disabled={!m.url}
                  onClick={() => void openUrl(m.url)}
                >
                  原帖
                </button>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 添加舆情 */}
      {addOpen ? (
        <div className={'gth-buzz-mask'} onClick={() => setAddOpen(false)}>
          <div
            className={'gth-buzz-modal'}
            role={'dialog'}
            aria-modal={'true'}
            aria-label={'添加舆情监控'}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={'gth-card-head'}>
              <span className={'gth-card-title'}>添加舆情监控</span>
              <button className={'gth-btn sm'} type={'button'} onClick={() => setAddOpen(false)}>
                关闭
              </button>
            </div>
            <div className={'gth-field'}>
              <span className={'gth-field-label'}>关联门店</span>
              <select
                className={'gth-select'}
                value={addStoreId}
                onChange={(e) => setAddStoreId(Number(e.target.value))}
              >
                <option value={0}>不关联(仅记录)</option>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name || s.brandName || '门店 ' + String(s.id)}
                  </option>
                ))}
              </select>
            </div>
            <div className={'gth-field'}>
              <span className={'gth-field-label'}>抖音 / 小红书 链接或分享口令</span>
              <textarea
                autoFocus
                className={'gth-input gth-input--area'}
                rows={5}
                placeholder={'支持: 抖音分享链接 / 口令文本 / 小红书笔记链接'}
                value={addText}
                onChange={(e) => setAddText(e.target.value)}
              />
              <span className={'gth-field-hint'}>
                解析后会保留原链接与封面, 并自动跑一次智能诊断
              </span>
            </div>
            <div className={'gth-btn-row'}>
              <button
                className={'gth-btn primary'}
                type={'button'}
                disabled={adding}
                onClick={() => void submitAdd()}
              >
                {adding ? '解析中…' : '解析并诊断'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* 详情抽屉 */}
      {detail ? (
        <>
          <div className={'gth-buzz-mask'} onClick={closeDetail} />
          <aside
            className={'gth-buzz-drawer'}
            role={'dialog'}
            aria-modal={'true'}
            aria-label={'舆情详情'}
          >
            <header className={'head'}>
              <span className={'title'}>舆情详情</span>
              <span className={'gth-badge gray'}>
                {PLATFORM_LABEL[detail.mention.platform] ?? detail.mention.platform}
              </span>
              <span className={'gth-badge gray'}>
                {STATUS_LABEL[detail.mention.status] ?? detail.mention.status}
              </span>
              <span style={{ flex: 1 }} />
              <button className={'gth-btn sm'} type={'button'} onClick={closeDetail}>
                关闭
              </button>
            </header>
            <div className={'body'}>
              {detailLoading ? <div className={'gth-detail-loading'}>加载中…</div> : null}
              <div className={'gth-buzz-src'}>
                <div className={'kv'}>
                  <div>
                    <span>标题</span>
                    <b>{detail.mention.title || '—'}</b>
                  </div>
                  <div>
                    <span>作者</span>
                    <b>
                      {detail.mention.authorName || '未知'}
                      {detail.mention.authorId ? ' (' + detail.mention.authorId + ')' : ''}
                    </b>
                  </div>
                  <div>
                    <span>发布</span>
                    <b>{fmt(detail.mention.publishedAt)}</b>
                  </div>
                  <div>
                    <span>门店</span>
                    <b>{detail.mention.storeName || '未关联'}</b>
                  </div>
                  <div>
                    <span>互动</span>
                    <b>
                      赞 {fmtNum(detail.mention.interactions.likes)} · 藏{' '}
                      {fmtNum(detail.mention.interactions.collects)} · 评{' '}
                      {fmtNum(detail.mention.interactions.comments)} · 转{' '}
                      {fmtNum(detail.mention.interactions.shares)}
                    </b>
                  </div>
                </div>
                <div className={'links'}>
                  <button
                    className={'gth-btn sm'}
                    type={'button'}
                    disabled={!detail.mention.url}
                    onClick={() => void openUrl(detail.mention.url)}
                  >
                    打开原帖查看视频/图文
                  </button>
                  <span className={'url'} title={detail.mention.url}>
                    {detail.mention.url || '—'}
                  </span>
                </div>
              </div>

              {detail.mention.contentText ? (
                <section className={'gth-buzz-sec'}>
                  <h4>原创内容</h4>
                  <div className={'text'}>{detail.mention.contentText}</div>
                </section>
              ) : null}

              {/* 诊断卡 */}
              <section className={'gth-buzz-sec'}>
                <h4>
                  智能诊断
                  <span
                    className={
                      'gth-badge ' +
                      (detail.mention.sentiment === 'negative'
                        ? 'red'
                        : detail.mention.sentiment === 'positive'
                          ? 'green'
                          : 'gray')
                    }
                  >
                    {SENTIMENT_LABEL[detail.mention.sentiment] ?? '待诊断'}
                  </span>
                  {detail.mention.diagnosedAt ? (
                    <span className={'score ' + sentimentClass(detail.mention.sentiment)}>
                      {detail.mention.score > 0 ? '+' : ''}
                      {String(detail.mention.score)} 分
                    </span>
                  ) : null}
                  <span
                    className={
                      'gth-badge ' +
                      (detail.mention.riskLevel === 'high'
                        ? 'red'
                        : detail.mention.riskLevel === 'medium'
                          ? 'amber'
                          : 'gray')
                    }
                  >
                    {RISK_LABEL[detail.mention.riskLevel] ?? '未评级'}
                  </span>
                  <span style={{ flex: 1 }} />
                  <button
                    className={'gth-btn sm primary'}
                    type={'button'}
                    disabled={busy === detail.mention.id}
                    onClick={() => void runDiagnose(detail.mention.id)}
                  >
                    {busy === detail.mention.id
                      ? '诊断中…'
                      : detail.mention.diagnosedAt
                        ? '重新诊断'
                        : '开始诊断'}
                  </button>
                </h4>
                {detail.mention.diagnosedAt ? (
                  <div className={'gth-buzz-diag'}>
                    {(() => {
                      const d = detail.mention.diagnosis as unknown as GrowthBuzzDiagnosisView
                      return (
                        <>
                          <p className={'summary'}>{d.summary}</p>
                          {d.redlineTags && d.redlineTags.length > 0 ? (
                            <div className={'redline'}>
                              ⚠ 食品安全/卫生红线: {d.redlineTags.join('、')} — 建议 2
                              小时内核实并留证
                            </div>
                          ) : null}
                          <div className={'scores'}>
                            <span>
                              规则分 <b>{String(d.ruleScore ?? '—')}</b>
                            </span>
                            <span>
                              模型分{' '}
                              <b>
                                {d.modelScore === null || d.modelScore === undefined
                                  ? '—'
                                  : String(d.modelScore)}
                              </b>
                            </span>
                            <span>
                              融合 <b>{String(d.finalScore ?? detail.mention.score)}</b>(规则 40% +
                              模型 60%)
                            </span>
                            <span>
                              依据{' '}
                              <b>
                                {d.source === 'rule+model' ? '词库 + 大模型' : '仅词库(模型不可用)'}
                              </b>
                            </span>
                          </div>
                          {d.reasons && d.reasons.length > 0 ? (
                            <div className={'reasons'}>
                              {d.reasons.map((r, i) => (
                                <span
                                  key={String(i)}
                                  className={'gth-chip' + (r.weight < 0 ? ' is-neg' : ' is-pos')}
                                >
                                  {r.tag} · {r.weight > 0 ? '+' : ''}
                                  {String(r.weight)} · {r.evidence}
                                </span>
                              ))}
                            </div>
                          ) : null}
                          <div className={'grid2'}>
                            <div>
                              <h5>根因</h5>
                              <ul>
                                {(d.rootCauses ?? []).map((x, i) => (
                                  <li key={String(i)}>{x}</li>
                                ))}
                              </ul>
                            </div>
                            <div>
                              <h5>处置建议</h5>
                              <ul>
                                {(d.suggestions ?? []).map((x, i) => (
                                  <li key={String(i)}>{x}</li>
                                ))}
                              </ul>
                            </div>
                          </div>
                          {d.spreadRisk ? (
                            <div className={'spread'}>传播风险: {d.spreadRisk}</div>
                          ) : null}
                        </>
                      )
                    })()}
                  </div>
                ) : (
                  <div className={'gth-buzz-diag empty'}>
                    还没有诊断结果, 点「开始诊断」按正文 + 评论给出评级与根因。
                  </div>
                )}
              </section>

              {/* 评论 */}
              <section className={'gth-buzz-sec'}>
                <h4>
                  评论区({detail.comments.length} 条 · 高赞 {detail.mention.highCommentCount} 条)
                </h4>
                {detail.comments.length === 0 ? (
                  <div className={'hint'}>
                    还没有评论。平台不开放评论区抓取, 请从 App 复制高赞评论粘贴到下方(格式:
                    赞数|作者|内容, 每行一条)。
                  </div>
                ) : (
                  <div className={'gth-buzz-cmts'}>
                    {detail.comments.map((c) => (
                      <div key={c.id} className={'gth-buzz-cmt' + (c.isHigh ? ' is-high' : '')}>
                        <span className={'meta'}>
                          {c.isHigh ? <span className={'gth-badge amber'}>高赞</span> : null}
                          <span className={'author'}>{c.authorName || '匿名'}</span>
                          <span className={'likes'}>赞 {fmtNum(c.likes)}</span>
                        </span>
                        <span className={'content'}>{c.content}</span>
                        <button
                          className={'gth-btn sm danger'}
                          type={'button'}
                          onClick={() => {
                            void (async () => {
                              if (!api) return
                              const res = await api.removeComment(c.id)
                              if (!res.ok) {
                                toast.error(res.error || '删除失败')
                                return
                              }
                              await openDetail(detail.mention.id)
                              await load()
                            })()
                          }}
                        >
                          删除
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <textarea
                  className={'gth-input gth-input--area'}
                  rows={4}
                  placeholder={
                    '赞数|作者|内容\n例如:\n128|吃货小王|牛肉很新鲜, 但等位等了 40 分钟\n32|小李|服务态度不错'
                  }
                  value={cmtDraft}
                  onChange={(e) => setCmtDraft(e.target.value)}
                />
                <div className={'gth-btn-row'}>
                  <button
                    className={'gth-btn primary sm'}
                    type={'button'}
                    disabled={busy === detail.mention.id || !cmtDraft.trim()}
                    onClick={() => void submitComments()}
                  >
                    {busy === detail.mention.id ? '处理中…' : '录入评论并重跑诊断'}
                  </button>
                </div>
              </section>

              {/* 处置 */}
              <section className={'gth-buzz-sec'}>
                <h4>处置</h4>
                <div className={'gth-buzz-statusrow'}>
                  {STATUS_KEYS.map((k) => (
                    <button
                      key={k}
                      className={'gth-btn sm' + (detail.mention.status === k ? ' primary' : '')}
                      type={'button'}
                      onClick={() => void patch(detail.mention.id, { status: k })}
                    >
                      {STATUS_LABEL[k]}
                    </button>
                  ))}
                  <span style={{ flex: 1 }} />
                  <select
                    className={'gth-select'}
                    value={detail.mention.storeId ?? 0}
                    onChange={(e) =>
                      void patch(detail.mention.id, { storeId: Number(e.target.value) })
                    }
                  >
                    <option value={0}>不关联门店</option>
                    {stores.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name || s.brandName || '门店 ' + String(s.id)}
                      </option>
                    ))}
                  </select>
                </div>
                <textarea
                  className={'gth-input gth-input--area'}
                  rows={2}
                  placeholder={'处置备注: 谁在什么时候做了什么(留痕用)'}
                  value={noteDraft}
                  onChange={(e) => setNoteDraft(e.target.value)}
                />
                <div className={'gth-btn-row'}>
                  <button
                    className={'gth-btn sm primary'}
                    type={'button'}
                    disabled={busy === detail.mention.id}
                    onClick={() => void toWorkbench(detail.mention.id)}
                  >
                    {busy === detail.mention.id ? '创建中…' : '转 AI 工作台生成回应'}
                  </button>
                  <button
                    className={'gth-btn sm'}
                    type={'button'}
                    onClick={() => void patch(detail.mention.id, { note: noteDraft })}
                  >
                    保存备注
                  </button>
                  <button
                    className={'gth-btn sm danger'}
                    type={'button'}
                    onClick={() => void removeOne(detail.mention.id)}
                  >
                    删除该舆情
                  </button>
                </div>
              </section>
            </div>
          </aside>
        </>
      ) : null}
    </div>
  )
}
