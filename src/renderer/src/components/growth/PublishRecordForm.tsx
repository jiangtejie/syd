import { useState } from 'react'
import { growthApi, fmt } from './meta'
import { toast } from '../../stores/toast'
import type { GrowthMetricView, GrowthRemixOutputView } from '../../../../shared/growth'

/**
 * 发布登记 + 效果历史（素材详情内）。
 *
 * 为什么要有这个表单：看板的「营销内容效果」空态一直指引用户「在素材详情里点登记发布」，
 * 而**那个按钮从来不存在** —— 唯一能写 growth_metric_snapshot 的路径是 AI 对话工具。
 * 于是漏斗永远没有数据、素材分永远不动、看板永远显示空态。
 *
 * 校验规则不在界面里：主进程 parsePublishMetrics（纯函数，有自检）说了算，这里只负责收集。
 */

const CHANNELS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'wxMoments', label: '微信朋友圈' },
  { value: 'wxGroup', label: '微信群' },
  { value: 'wxChat', label: '微信私聊' },
  { value: 'douyin', label: '抖音' },
  { value: 'xhs', label: '小红书' },
  { value: 'video', label: '视频号' },
  { value: 'other', label: '其他' }
]

const CHANNEL_LABEL: Record<string, string> = Object.fromEntries(
  CHANNELS.map((c) => [c.value, c.label])
)

const NUM_FIELDS: ReadonlyArray<{ key: string; label: string; ph: string }> = [
  { key: 'likes', label: '点赞', ph: '0' },
  { key: 'collects', label: '收藏', ph: '0' },
  { key: 'comments', label: '评论', ph: '0' },
  { key: 'shares', label: '转发', ph: '0' },
  { key: 'follows', label: '新增关注', ph: '0' },
  { key: 'leads', label: '新客线索', ph: '0' },
  { key: 'amount', label: '成交金额 ¥', ph: '0' }
]

export function PublishRecordForm({
  contentId,
  metrics,
  outputs,
  onSaved
}: {
  contentId: number
  metrics: GrowthMetricView[]
  outputs: GrowthRemixOutputView[]
  /** 登记成功后刷新详情（重新拉 metrics 与素材分） */
  onSaved: () => void | Promise<void>
}): React.JSX.Element {
  const [channel, setChannel] = useState('wxMoments')
  const [outputId, setOutputId] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const setField = (key: string, v: string): void => setValues((s) => ({ ...s, [key]: v }))

  const submit = async (): Promise<void> => {
    if (!growthApi?.recordPublish) {
      toast.error('通道未就绪（改到主进程/preload 后需完全重启应用）')
      return
    }
    setBusy(true)
    try {
      const res = await growthApi.recordPublish(contentId, {
        channel,
        outputId: outputId ? Number(outputId) : null,
        ...values
      })
      if (!res.ok) {
        toast.error(res.error || '登记失败')
        return
      }
      toast.success(`已登记发布（素材分 ${res.score ?? '-'}）`)
      setValues({})
      await onSaved()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '登记失败')
    } finally {
      setBusy(false)
    }
  }

  const totals = metrics.reduce(
    (acc, m) => ({
      likes: acc.likes + (m.likes || 0),
      collects: acc.collects + (m.collects || 0),
      comments: acc.comments + (m.comments || 0),
      shares: acc.shares + (m.shares || 0),
      follows: acc.follows + (m.follows || 0),
      leads: acc.leads + (m.leads || 0),
      amount: acc.amount + (m.amount || 0)
    }),
    { likes: 0, collects: 0, comments: 0, shares: 0, follows: 0, leads: 0, amount: 0 }
  )

  return (
    <div className={'gth-ops'}>
      <div className={'gth-ops-row'}>
        <label className={'gth-ops-fld'}>
          <span className={'lb'}>发布渠道</span>
          <select
            className={'ui-select gth-select'}
            value={channel}
            disabled={busy}
            onChange={(e) => setChannel(e.target.value)}
          >
            {CHANNELS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className={'gth-ops-fld'}>
          <span className={'lb'}>归因产出</span>
          <select
            className={'ui-select gth-select'}
            value={outputId}
            disabled={busy}
            onChange={(e) => setOutputId(e.target.value)}
          >
            <option value={''}>不指定</option>
            {outputs.map((o) => (
              <option key={o.id} value={String(o.id)}>
                #{o.id} {o.variant === 'titles' ? '标题组' : o.variant}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className={'gth-ops-row'}>
        {NUM_FIELDS.map((f) => (
          <label key={f.key} className={'gth-ops-fld'}>
            <span className={'lb'}>{f.label}</span>
            <input
              className={'ui-input gth-input'}
              inputMode={'decimal'}
              value={values[f.key] ?? ''}
              placeholder={f.ph}
              disabled={busy}
              onChange={(e) => setField(f.key, e.target.value)}
            />
          </label>
        ))}
        <button
          className={'ui-btn is-primary gth-btn sm'}
          type={'button'}
          disabled={busy}
          onClick={() => void submit()}
        >
          {busy ? '登记中…' : '登记发布'}
        </button>
      </div>
      <div className={'gth-ops-hint'}>
        登记后素材分与看板「营销内容效果」立即更新。空着不填的项按 0 计；至少填一项。
      </div>

      {metrics.length > 0 && (
        <>
          <div className={'gth-ops-row'}>
            <span className={'gth-ops-hint'}>
              合计（历次登记之和，{metrics.length} 次）：赞 {totals.likes} · 藏 {totals.collects} ·
              评 {totals.comments} · 转 {totals.shares} · 关注 {totals.follows} · 线索{' '}
              {totals.leads} · ¥{Math.round(totals.amount * 100) / 100}
            </span>
          </div>
          <div className={'gth-ops-row'}>
            <div className={'rel-fails'}>
              <div className={'rel-fails-title'}>效果登记历史</div>
              {metrics.slice(0, 8).map((m) => (
                <div key={m.id} className={'rel-fail'}>
                  <time>{fmt(m.capturedAt)}</time>
                  <span>
                    {CHANNEL_LABEL[m.channel] ?? m.channel}
                    {m.outputId ? ` · 产出 #${m.outputId}` : ''} · 赞 {m.likes} · 关注 {m.follows} ·
                    线索 {m.leads} · ¥{m.amount}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

export default PublishRecordForm
