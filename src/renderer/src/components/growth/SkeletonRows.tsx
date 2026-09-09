/**
 * 列表骨架屏(营销模块加载态统一使用)。
 * 纯 CSS shimmer(伪元素 + transform), 见 growth.css .gth-skel。
 */

interface SkeletonRowsProps {
  rows?: number
  /** 行内右侧列数量(0 = 仅标题列) */
  cols?: number
}

export default function SkeletonRows({ rows = 6, cols = 2 }: SkeletonRowsProps): React.JSX.Element {
  return (
    <div className={'gth-list gth-skel-list'}>
      {Array.from({ length: rows }).map((_, i) => (
        <div className={'gth-skel-row'} key={i}>
          <span className={'gth-skel'} style={{ width: 15, height: 15, borderRadius: 4 }} />
          <span className={'gth-skel-col'}>
            <span className={'gth-skel'} style={{ width: 42 - i * 2 + '%', height: 13 }} />
            <span className={'gth-skel'} style={{ width: 24 - i + '%', height: 11 }} />
          </span>
          {cols >= 1 ? (
            <span className={'gth-skel'} style={{ width: 64, height: 20, borderRadius: 999 }} />
          ) : null}
          {cols >= 2 ? <span className={'gth-skel'} style={{ width: 92, height: 12 }} /> : null}
        </div>
      ))}
    </div>
  )
}
