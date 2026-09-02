import { useToastStore } from '../stores/toast'

/** Toast 挂载点：固定顶部居中，动画淡入淡出 */
function ToastHost(): React.JSX.Element {
  const toasts = useToastStore((s) => s.toasts)
  if (toasts.length === 0) return <></>
  return (
    <div className="toast-host">
      {toasts.map((t) => (
        <div key={t.id} className={`toast-item toast-${t.kind}`}>
          {t.kind === 'success' && <span className="toast-icon">✓</span>}
          {t.kind === 'error' && <span className="toast-icon">✕</span>}
          {t.text}
        </div>
      ))}
    </div>
  )
}

export default ToastHost
