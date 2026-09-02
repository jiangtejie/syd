import { create } from 'zustand'

/**
 * 全局 Toast（参考 CipherTalk useTopToast 模式：统一入口、统一时长）。
 * 用法：toast.success('已复制') / toast.error('发送失败')
 */

export interface ToastItem {
  id: number
  kind: 'success' | 'error' | 'info'
  text: string
}

interface ToastState {
  toasts: ToastItem[]
  push: (kind: ToastItem['kind'], text: string) => void
  remove: (id: number) => void
}

let seq = 0

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (kind, text) => {
    const id = ++seq
    set((s) => ({ toasts: [...s.toasts.slice(-2), { id, kind, text }] })) // 最多 3 条
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
    }, 2000)
  },
  remove: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}))

export const toast = {
  success: (text: string): void => useToastStore.getState().push('success', text),
  error: (text: string): void => useToastStore.getState().push('error', text),
  info: (text: string): void => useToastStore.getState().push('info', text)
}
