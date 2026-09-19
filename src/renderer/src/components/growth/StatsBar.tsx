import { useCountUp } from '../../lib/useCountUp'
import type { GrowthStats } from '../../../../shared/growth'

export interface StatsBarProps {
  stats: GrowthStats | null
}

/** 指标卡图标(线性 16px) */
export function IcMetricBox(): React.JSX.Element {
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

export function IcMetricMedia(): React.JSX.Element {
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

/**
 * 素材规模指标。
 *
 * 布局口径（2026-09）：从「两张 ~92px 高的大卡」压成一行 36px 的紧凑指标 ——
 * 它们说的是「有多少素材」，不值得占掉近 100px 的首屏高度；省下的高度给列表与表单。
 * 数字与标签同排（值在前、名字在后），视线一次扫完。
 */
export function StatsBar({ stats }: StatsBarProps): React.JSX.Element {
  const contentCount = useCountUp(stats ? stats.contentCount : null)
  const assetCount = useCountUp(stats ? stats.assetCount : null)
  return (
    <div className={'gth-cards'}>
      <div className={'page-card gth-metric'}>
        <span className={'gth-metric-ic'}>
          <IcMetricBox />
        </span>
        <span className={'gth-metric-num'}>{contentCount ?? '—'}</span>
        <span className={'gth-metric-label'}>仓库素材</span>
      </div>
      <div className={'page-card gth-metric tone-violet'}>
        <span className={'gth-metric-ic'}>
          <IcMetricMedia />
        </span>
        <span className={'gth-metric-num'}>{assetCount ?? '—'}</span>
        <span className={'gth-metric-label'}>媒体文件</span>
      </div>
    </div>
  )
}
