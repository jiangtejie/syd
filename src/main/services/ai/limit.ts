/**
 * 极简并发闸门（零依赖）。
 *
 * 为什么要它：AI 调用以前没有任何并发控制 —— 群问题提取、数字员工值班、AI 工作台、
 * 营销爆改可以同时打上去，撞上限流就是一批一起失败。这里给一个全局上限，超出的排队。
 * 不做优先级、不做超时：排队等不到就直接失败更糟，宁可等。
 */
export interface Limiter {
  run<T>(fn: () => Promise<T>): Promise<T>
  /** 当前在跑 / 在排队（供设置页展示与排障） */
  stats(): { active: number; queued: number; max: number }
}

export function createLimiter(max: number): Limiter {
  const limit = Math.max(1, Math.floor(max) || 1)
  let active = 0
  const queue: Array<() => void> = []

  const next = (): void => {
    const run = queue.shift()
    if (run) run()
  }

  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const start = (): void => {
          active += 1
          // 用 async IIFE + try/finally：① fn 抛同步错也要走 reject 而不是把闸门卡死；
          // ② 计数与放行必须在**同一个同步块**里完成 —— 若挂在 Promise.finally 上，
          //    它会晚一个微任务执行，调用方在 catch 里看到的 active 就是没归零的（自检发现的）。
          void (async () => {
            try {
              resolve(await fn())
            } catch (e) {
              reject(e)
            } finally {
              active -= 1
              next()
            }
          })()
        }
        if (active < limit) start()
        else queue.push(start)
      })
    },
    stats: () => ({ active, queued: queue.length, max: limit })
  }
}
