import { create } from 'zustand'

/**
 * 全局确认弹窗(替代原生 window.confirm):
 * confirmAsk({...}) → Promise<boolean>;由 App 挂载 ConfirmHost 渲染统一弹窗。
 */

export interface AskOptions {
  title: string
  message?: string
  confirmText?: string
  cancelText?: string
  /** 危险操作(删除/清空):确认按钮红系 */
  danger?: boolean
}

type Resolver = (ok: boolean) => void

interface ConfirmState {
  options: (AskOptions & { resolve: Resolver }) | null
  ask: (o: AskOptions) => Promise<boolean>
  close: (ok: boolean) => void
}

export const useConfirmDialogStore = create<ConfirmState>((set, get) => ({
  options: null,
  ask: (o) =>
    new Promise<boolean>((resolve) => {
      set({ options: { ...o, resolve } })
    }),
  close: (ok) => {
    const cur = get().options
    if (!cur) return
    set({ options: null })
    cur.resolve(ok)
  }
}))

/** 直接调用:const ok = await confirmAsk({...});ok=false 即取消 */
export function confirmAsk(o: AskOptions): Promise<boolean> {
  return useConfirmDialogStore.getState().ask(o)
}
