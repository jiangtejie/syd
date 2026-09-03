import { useToastStore } from '../stores/toast'

/** 图标：对勾 / 叉（跟随 currentColor 的描边，避免文字符号在 DPI 下发虚） */
function ToastGlyph({ kind }: { kind: 'success' | 'error' }): React.JSX.Element {
  const common = {
    width: 14,
    height: 14,
    viewBox: '0 0 16 16',
    fill: 'none' as const,
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true
  }
  return kind === 'success' ? (
    <svg {...common}>
      <path d="M2.8 8.6l3.4 3.4 7-7" />
    </svg>
  ) : (
    <svg {...common}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  )
}

/** Toast 挂载点：固定顶部居中，动画淡入淡出 */
function ToastHost(): React.JSX.Element {
  const toasts = useToastStore((s) => s.toasts)
  if (toasts.length === 0) return <></>
  return (
    // aria-live：Toast 出现时对读屏用户播报最新状态
    <div className="toast-host" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast-item toast-${t.kind}`}>
          {(t.kind === 'success' || t.kind === 'error') && (
            <span className="toast-icon">
              <ToastGlyph kind={t.kind} />
            </span>
          )}
          {t.text}
        </div>
      ))}
    </div>
  )
}

export default ToastHost
