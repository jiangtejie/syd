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

export function IcMetricRss(): React.JSX.Element {
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

export function IcMetricPlug(): React.JSX.Element {
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

export function StatsBar({ stats }: StatsBarProps): React.JSX.Element {
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
