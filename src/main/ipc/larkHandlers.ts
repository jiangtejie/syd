import { ipcMain } from 'electron'
import { larkConfigStatus } from '../services/lark/client'
import { testLarkAccess } from '../services/lark/api'

/**
 * 飞书云文档 IPC(cs:lark:*):设置页的状态展示与连通性测试。
 * 凭证本身走 cs:config:set(lark.appId / lark.appSecret,lark.appSecret 自动加封),
 * 这里只提供「是否已配置/来源」与「按链接实测能否读到」。
 */
export function registerLarkHandlers(): void {
  ipcMain.handle('cs:lark:status', () => {
    try {
      return { ok: true as const, ...larkConfigStatus() }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : '读取飞书配置失败' }
    }
  })

  ipcMain.handle('cs:lark:test', async (_e, url: string) => {
    const target = typeof url === 'string' ? url.trim() : ''
    if (!target) return { ok: false as const, error: '请先填写要测试的飞书链接' }
    try {
      const r = await testLarkAccess(target)
      return r.ok ? { ok: true as const, text: r.text } : { ok: false as const, error: r.text }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : '测试失败' }
    }
  })
}
