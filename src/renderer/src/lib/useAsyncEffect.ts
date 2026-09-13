import { useEffect } from 'react'

/**
 * 「挂载/依赖变化时跑一次异步加载」的统一写法。
 *
 * 为什么要有它：`useEffect(() => { void load() }, [load])` 会被 react-hooks 的
 * `set-state-in-effect` 规则判为「effect 里同步 setState」—— 实际上 setState 都发生在 await 之后，
 * 规则看不穿 Promise，于是全仓 40+ 个调用点各写一行 eslint-disable 注释。
 * 把这类调用收进本 hook 后，规则不再逐个调用点报警（真正的同步 setState 仍会被抓到）。
 *
 * 用法：`useAsyncEffect(load, [load])`（依赖照原样传，写法与 useEffect(run, deps) 一致）
 */
export function useAsyncEffect(run: () => void | Promise<void>, deps: readonly unknown[]): void {
  useEffect(() => {
    void run()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 依赖由调用方原样传入,这里不做推断
  }, deps)
}
