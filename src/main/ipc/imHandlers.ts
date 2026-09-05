import { ipcMain } from 'electron'
import {
  listImAccounts,
  saveImAccount,
  removeImAccount,
  setImAccountEnabled,
  rowToAccount,
  getImAccountConfig
} from '../db/repos/imRepo'
import {
  startFeishuAccount,
  stopFeishuAccount,
  getImStatus,
  stopAllFeishu
} from '../services/im/feishuService'
import { sealSecret } from '../services/secrets'
import type { ImChannelAccountInput } from '../../shared/types'

/** IM 渠道账号 IPC(一期:飞书)。凭证 appSecret 以 safeStorage enc1 密文落库。 */

async function refreshAccount(id: number | undefined): Promise<{ ok: boolean; error?: string }> {
  if (id === undefined) return { ok: true }
  const rows = listImAccounts()
  const row = rows.find((r) => r.id === id)
  if (!row) return { ok: true }
  if (row.enabled === 1) {
    return await startFeishuAccount(row.id, row.name)
  }
  stopFeishuAccount(row.id)
  return { ok: true }
}

export function registerImHandlers(): void {
  ipcMain.handle('cs:im:list', async () => {
    try {
      const rows = listImAccounts()
      const out = rows.map((r) => {
        const item = rowToAccount(r)
        const st = getImStatus(r.id)
        return { ...item, status: st.status, statusText: st.statusText }
      })
      return { ok: true as const, accounts: out }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:im:save', async (_e, input: ImChannelAccountInput) => {
    try {
      // 编辑场景:未新填 Secret 时沿用库中已加密值(只改绑定/名称无需重输密钥)
      const prev = input?.id ? getImAccountConfig(input.id) : undefined
      const saved = saveImAccount({
        id: input?.id,
        name: input?.name ?? '',
        enabled: input?.enabled,
        config: {
          appId: (input?.appId?.trim() || prev?.appId) ?? '',
          appSecret: input?.appSecret ? sealSecret(input.appSecret) : (prev?.appSecret ?? ''),
          wxid: (input?.wxid ?? '').trim() || undefined
        }
      })
      if (!saved.ok || saved.id === undefined) return saved
      // 配置可能变更(绑定账号/凭证):先断开再按新配置重连,确保立即生效
      if (input?.id) stopFeishuAccount(input.id)
      const started = await refreshAccount(saved.id)
      // 账号已落库;连接失败时把原因带给前端展示
      if (!started.ok) return { ok: true as const, id: saved.id, error: started.error }
      return { ok: true as const, id: saved.id }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:im:remove', (_e, id: number) => {
    if (!Number.isInteger(id)) return { ok: false as const, error: '参数错误' }
    try {
      stopFeishuAccount(id)
      if (!removeImAccount(id)) return { ok: false as const, error: '账号不存在' }
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cs:im:toggle', async (_e, id: number, enabled: boolean) => {
    if (!Number.isInteger(id)) return { ok: false as const, error: '参数错误' }
    try {
      if (!setImAccountEnabled(id, !!enabled)) return { ok: false as const, error: '账号不存在' }
      const started = await refreshAccount(id)
      if (!started.ok) return { ok: false as const, error: started.error }
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })
}

/** 应用退出/重载时停掉全部长连接(由 index.ts before-quit 调用) */
export function stopAllIm(): void {
  stopAllFeishu()
}

/** 启动时恢复所有启用账号(由 index.ts 注册处调用) */
export async function bootImAccounts(): Promise<void> {
  for (const r of listImAccounts()) {
    if (r.enabled === 1) {
      const cfg = getImAccountConfig(r.id)
      if (cfg.appId?.trim()) {
        await startFeishuAccount(r.id, r.name)
      }
    }
  }
}
