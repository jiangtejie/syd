import { ipcMain } from 'electron'
import {
  listImAccounts,
  saveImAccount,
  removeImAccount,
  setImAccountEnabled,
  rowToAccount,
  getImAccountConfig,
  type ImAccountConfig
} from '../db/repos/imRepo'
import {
  startFeishuAccount,
  stopFeishuAccount,
  getImStatus,
  stopAllFeishu
} from '../services/im/feishuService'
import {
  startWechatClawAccount,
  stopWechatClawAccount,
  getWechatClawStatus,
  stopAllWechatClaw,
  clawQrStart,
  clawQrPoll
} from '../services/im/wechatClawService'
import { sealSecret } from '../services/secrets'
import type { ImChannelAccountInput, ImChannelKind } from '../../shared/types'
import { fail } from './_util'

/** IM 渠道账号 IPC(飞书机器人 / 微信 ClawBot)。凭证以 safeStorage enc1 密文落库。 */

type RuntimeStop = (id: number) => void
type RuntimeStart = (id: number, name: string) => Promise<{ ok: boolean; error?: string }>
type RuntimeStatus = (id: number) => { status?: string; statusText?: string }

const stops: Record<ImChannelKind, RuntimeStop> = {
  feishu: stopFeishuAccount,
  wechat_claw: stopWechatClawAccount
}
const starts: Record<ImChannelKind, RuntimeStart> = {
  feishu: startFeishuAccount,
  wechat_claw: startWechatClawAccount
}
const statusOf: Record<ImChannelKind, RuntimeStatus> = {
  feishu: getImStatus,
  wechat_claw: getWechatClawStatus
}

async function refreshAccount(id: number): Promise<{ ok: boolean; error?: string }> {
  if (id === undefined) return { ok: true }
  const row = listImAccounts().find((r) => r.id === id)
  if (!row) return { ok: true }
  const kind = (row.channel === 'wechat_claw' ? 'wechat_claw' : 'feishu') as ImChannelKind
  if (row.enabled === 1) {
    return await starts[kind](row.id, row.name)
  }
  stops[kind](row.id)
  return { ok: true }
}

export function registerImHandlers(): void {
  ipcMain.handle('cs:im:list', async () => {
    try {
      const rows = listImAccounts()
      const out = rows.map((r) => {
        const item = rowToAccount(r)
        const kind = item.channel
        const st = statusOf[kind](r.id)
        return { ...item, status: st.status, statusText: st.statusText }
      })
      return { ok: true as const, accounts: out }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('cs:im:save', async (_e, input: ImChannelAccountInput) => {
    try {
      const kind: ImChannelKind = input?.channel === 'wechat_claw' ? 'wechat_claw' : 'feishu'
      // 编辑场景:未新填的密文沿用库中已加密值(只改绑定/名称无需重输)
      const prev = input?.id ? getImAccountConfig(input.id) : undefined
      const cfg: ImAccountConfig = {
        appId: (input?.appId?.trim() || prev?.appId) ?? '',
        appSecret: input?.appSecret ? sealSecret(input.appSecret) : (prev?.appSecret ?? ''),
        clawToken: input?.clawToken ? sealSecret(input.clawToken) : (prev?.clawToken ?? ''),
        baseUrl: (input?.baseUrl ?? '').trim() || prev?.baseUrl,
        wxid: (input?.wxid ?? '').trim() || undefined,
        allowUsers: (input?.allowUsers ?? '').trim() || undefined,
        receiveMode:
          input?.receiveMode === 'off' || input?.receiveMode === 'allowlist'
            ? input.receiveMode
            : 'all',
        permissions: input?.permissions ?? prev?.permissions
      }
      const saved = saveImAccount({
        id: input?.id,
        channel: kind,
        name: input?.name ?? '',
        enabled: input?.enabled,
        config: cfg
      })
      if (!saved.ok || saved.id === undefined) return saved
      // 配置可能变更(绑定/凭证):先断开再按新配置重连,确保立即生效
      if (input?.id) stops[kind](input.id)
      const started = await refreshAccount(saved.id)
      if (!started.ok) return { ok: true as const, id: saved.id, error: started.error }
      return { ok: true as const, id: saved.id }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('cs:im:remove', (_e, id: number) => {
    if (!Number.isInteger(id)) return { ok: false as const, error: '参数错误' }
    try {
      const row = listImAccounts().find((r) => r.id === id)
      if (row) {
        const kind = (row.channel === 'wechat_claw' ? 'wechat_claw' : 'feishu') as ImChannelKind
        stops[kind](id)
      }
      if (!removeImAccount(id)) return { ok: false as const, error: '账号不存在' }
      return { ok: true as const }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('cs:im:toggle', async (_e, id: number, enabled: boolean) => {
    if (!Number.isInteger(id)) return { ok: false as const, error: '参数错误' }
    try {
      const row = listImAccounts().find((r) => r.id === id)
      if (!row) return { ok: false as const, error: '账号不存在' }
      if (!setImAccountEnabled(id, !!enabled)) return { ok: false as const, error: '账号不存在' }
      const started = await refreshAccount(id)
      if (!started.ok) return { ok: false as const, error: started.error }
      return { ok: true as const }
    } catch (err) {
      return fail(err)
    }
  })

  // ── ClawBot 扫码绑定:获取二维码(渲染端只见图片/URL,token 只留在主进程) ──
  ipcMain.handle(
    'cs:im:clawQrStart',
    async (_e, opts: { name: string; baseUrl?: string; wxid?: string; allowUsers?: string }) => {
      try {
        return await clawQrStart(opts ?? {})
      } catch (err) {
        return {
          ok: false as const,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }
  )

  ipcMain.handle('cs:im:clawQrPoll', async (_e, key: string) => {
    if (typeof key !== 'string' || !key) {
      return { ok: false as const, status: 'error' as const, error: '参数错误' }
    }
    try {
      return await clawQrPoll(key)
    } catch (err) {
      return {
        ok: false as const,
        status: 'error' as const,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  })
}

/** 应用退出/重载时停掉全部长连接/轮询(由 index.ts before-quit 调用) */
export function stopAllIm(): void {
  stopAllFeishu()
  stopAllWechatClaw()
}

/** 启动时恢复所有启用账号(由 index.ts 注册处调用) */
export async function bootImAccounts(): Promise<void> {
  for (const r of listImAccounts()) {
    if (r.enabled !== 1) continue
    const kind = (r.channel === 'wechat_claw' ? 'wechat_claw' : 'feishu') as ImChannelKind
    const cfg = getImAccountConfig(r.id)
    const hasKey = kind === 'feishu' ? cfg.appId?.trim() : cfg.clawToken?.trim()
    if (!hasKey) continue
    await starts[kind](r.id, r.name)
  }
}
