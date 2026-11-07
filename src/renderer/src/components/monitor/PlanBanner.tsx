import { useEffect, useRef } from 'react'

/** 存量去重的预览方案（与主进程 mergeDuplicateIssues 的返回结构一致） */
export interface DuplicatePlanView {
  clusters: number
  merged: number
  plan: Array<{
    keepId: number
    keepTitle: string
    dropIds: number[]
    dropTitles: string[]
    groupName: string
    reasons: string[]
    /** 高置信：开启自动合并后由后台直接处理 */
    strong?: boolean
    /** 本可自动合并但组内多人跟进 → 留给人工 */
    skippedAuto?: boolean
  }>
}

/**
 * 维护操作的**页内**方案/确认条（不依赖全局确认弹窗：弹窗没渲染出来时用户只看到「点了没反应」）。
 * 出现时自动滚动到可视区，确认/取消按钮就在手边。
 */
export function PlanBanner({
  dupPlan,
  archiveAsk,
  busy,
  onExecuteMerge,
  onCancelMerge,
  onExecuteArchive,
  onCancelArchive
}: {
  dupPlan: DuplicatePlanView | null
  archiveAsk: boolean
  busy: boolean
  onExecuteMerge: () => void
  onCancelMerge: () => void
  onExecuteArchive: () => void
  onCancelArchive: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (dupPlan || archiveAsk) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [dupPlan, archiveAsk])

  return (
    <div ref={ref}>
      {dupPlan && (
        <div className="page-card mon-plan">
          <div className="mon-plan-head">
            <b>合并重复议题</b>
            <span className="mon-plan-sub">
              发现 <b className="ui-num">{dupPlan.clusters}</b> 组重复、共{' '}
              <b className="ui-num">{dupPlan.merged}</b> 条冗余记录（
              {dupPlan.plan.reduce((s, x) => s + x.dropIds.length + 1, 0)} 条 → {dupPlan.clusters}{' '}
              条）
            </span>
            <span className="mon-plan-spacer" />
            <button
              type="button"
              className="ui-btn is-danger is-sm"
              disabled={busy}
              onClick={() => void onExecuteMerge()}
            >
              {busy ? (
                '合并中…'
              ) : (
                <>
                  执行合并（<span className="ui-num">{dupPlan.merged}</span>）
                </>
              )}
            </button>
            <button
              type="button"
              className="ui-btn is-ghost is-sm"
              disabled={busy}
              onClick={() => onCancelMerge()}
            >
              取消
            </button>
          </div>
          <div className="mon-plan-list">
            {dupPlan.plan.map((it) => (
              <div key={it.keepId} className="mon-plan-item">
                <span className="mon-plan-keep" title={it.keepTitle}>
                  保留 · {it.keepTitle}
                </span>
                <span className="mon-plan-drop">
                  ← 合并 {it.dropIds.length} 条
                  {it.dropTitles.length > 0
                    ? `：${it.dropTitles
                        .slice(0, 2)
                        .map((x) => x.slice(0, 14))
                        .join(' / ')}${it.dropTitles.length > 2 ? ' 等' : ''}`
                    : ''}
                </span>
                {it.strong && (
                  <span
                    className="ui-chip is-sm mon-plan-why"
                    title="高置信：开启「自动合并重复议题」后由后台自动处理"
                  >
                    高置信
                  </span>
                )}
                {it.reasons.length > 0 && (
                  <span className="ui-chip is-sm mon-plan-why" title={it.reasons.join('；')}>
                    {it.reasons[0]}
                  </span>
                )}
              </div>
            ))}
          </div>
          <div className="mon-plan-note">
            每组保留最早的一条：合并证据、取最高严重度、沿用指派跟进人；其余归档为「重复」——
            不计入闭环率与趋势、不作为「不是问题」的反例样本，需要时可重新打开。
            {dupPlan.plan.some((x) => x.strong)
              ? ` 其中 ${dupPlan.plan.filter((x) => x.strong).length} 组为高置信，开启「设置 → 自动合并重复议题」后这类会由后台直接处理。`
              : ''}
          </div>
        </div>
      )}
      {archiveAsk && (
        <div className="page-card mon-plan">
          <div className="mon-plan-head">
            <b>归档历史记录</b>
            <span className="mon-plan-sub">
              把 90 天前「已解决 / 已搁置」的记录标为已归档：不再出现在待办、盯办与徽标里，
              累计闭环率与趋势照旧统计它们，可在「已归档」筛选查看。
            </span>
            <span className="mon-plan-spacer" />
            <button
              type="button"
              className="ui-btn is-primary is-sm"
              onClick={() => void onExecuteArchive()}
            >
              确认归档
            </button>
            <button
              type="button"
              className="ui-btn is-ghost is-sm"
              onClick={() => onCancelArchive()}
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
