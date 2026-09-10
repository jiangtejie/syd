import ConfirmDialog from './ConfirmDialog'
import { useConfirmDialogStore } from '../stores/confirmDialog'

/** 全局确认宿主:配合 confirmAsk() 使用,由 App 挂在 ToastHost 旁 */
export default function ConfirmHost(): React.JSX.Element {
  const options = useConfirmDialogStore((s) => s.options)
  const close = useConfirmDialogStore((s) => s.close)
  const display = options
    ? {
        title: options.title,
        message: options.message,
        confirmText: options.confirmText,
        cancelText: options.cancelText,
        danger: options.danger
      }
    : null
  // onResolve 只调一次：close(ok) 结算 Promise 并清空 options（弹窗随之卸载）
  return <ConfirmDialog options={display} onResolve={close} />
}
