import * as lark from '@larksuiteoapi/node-sdk'
import { getConfig } from '../../db/repos/config'
import { getImAccountConfig, listImAccounts } from '../../db/repos/imRepo'
import { openSecret } from '../secrets'

/**
 * 飞书应用凭证与 SDK 客户端(应用身份 tenant_access_token)。
 *
 * 凭证来源优先级:
 *   1. 设置 → AI 助手 → 飞书云文档 的 lark.appId / lark.appSecret(safeStorage 加封);
 *   2. 复用 IM 渠道里已保存的飞书自建应用(im_channel_account, channel=feishu)。
 * 两者都没有时, 工具会返回可行动的配置提示, 而不是抛错。
 *
 * 权限提醒: 应用身份能读到的文档, 必须显式把该应用加为文档协作者(分享 → 添加协作者),
 * 且应用已在开放平台开通对应只读权限并发布版本; 否则接口返回 403 / 权限类错误码。
 */

export type LarkCredSource = 'config' | 'im' | 'none'

export interface LarkCredential {
  appId: string
  appSecret: string
  source: LarkCredSource
  /** 来源为 IM 渠道时的账号名(设置页展示用) */
  accountName?: string
}

/** 本模块只声明用到的 SDK 方法, 避免引入 SDK 的巨型类型 */
export interface LarkApi {
  bitable: {
    appTable: {
      list: (payload: unknown) => Promise<unknown>
      create: (payload: unknown) => Promise<unknown>
    }
    appTableField: {
      list: (payload: unknown) => Promise<unknown>
      create: (payload: unknown) => Promise<unknown>
    }
    appTableRecord: {
      list: (payload: unknown) => Promise<unknown>
      create: (payload: unknown) => Promise<unknown>
      update: (payload: unknown) => Promise<unknown>
      delete: (payload: unknown) => Promise<unknown>
      batchCreate: (payload: unknown) => Promise<unknown>
      batchUpdate: (payload: unknown) => Promise<unknown>
    }
  }
  docx: { document: { rawContent: (payload: unknown) => Promise<unknown> } }
  wiki: { space: { getNode: (payload: unknown) => Promise<unknown> } }
  /** 原始调用逃生口(SDK 自动补 domain 与鉴权头;url 不带前导斜杠) */
  request: (payload: {
    method?: string
    url: string
    params?: Record<string, unknown>
    data?: Record<string, unknown>
  }) => Promise<unknown>
}

let credCache: { key: string; value: LarkCredential } | null = null

export function getLarkCredential(): LarkCredential {
  const appId = (getConfig('lark.appId') ?? '').trim()
  const appSecret = openSecret(getConfig('lark.appSecret'))
  const key = `${appId}\n${appSecret}`
  if (credCache && credCache.key === key) return credCache.value
  let value: LarkCredential
  if (appId && appSecret) {
    value = { appId, appSecret, source: 'config' }
  } else {
    value = fromImAccounts()
  }
  credCache = { key, value }
  return value
}

/** 复用 IM 渠道的飞书自建应用凭证(启用中的账号优先) */
function fromImAccounts(): LarkCredential {
  try {
    const rows = listImAccounts().filter((r) => r.channel === 'feishu')
    rows.sort((a, b) => b.enabled - a.enabled || a.created_at - b.created_at)
    for (const r of rows) {
      const cfg = getImAccountConfig(r.id)
      const appId = (cfg.appId ?? '').trim()
      const appSecret = openSecret(cfg.appSecret)
      if (appId && appSecret) {
        return { appId, appSecret, source: 'im', accountName: r.name }
      }
    }
  } catch {
    /* IM 表缺失/损坏时视为未配置 */
  }
  return { appId: '', appSecret: '', source: 'none' }
}

let clientCache: { appId: string; api: LarkApi } | null = null

/** 已配置则返回 SDK 客户端;未配置返回 null(调用方用 noCredentialHint() 提示用户) */
export function larkApiClient(): { api: LarkApi; cred: LarkCredential } | null {
  const cred = getLarkCredential()
  if (!cred.appId || !cred.appSecret) return null
  if (clientCache && clientCache.appId === cred.appId) {
    return { api: clientCache.api, cred }
  }
  const client = new lark.Client({
    appId: cred.appId,
    appSecret: cred.appSecret,
    appType: lark.AppType.SelfBuild
  })
  const api = client as unknown as LarkApi
  clientCache = { appId: cred.appId, api }
  return { api, cred }
}

export type LarkCallResult<T> = { ok: true; data: T } | { ok: false; error: string }

/** 统一调用包装:自动取客户端;code!==0 与网络异常都转成人话 */
export async function larkCall<T>(
  fn: (api: LarkApi) => Promise<unknown>
): Promise<LarkCallResult<T>> {
  const c = larkApiClient()
  if (!c) return { ok: false, error: noCredentialHint() }
  try {
    const res = (await fn(c.api)) as { code?: number; msg?: string; data?: T } | undefined
    const code = res?.code
    if (typeof code === 'number' && code !== 0) {
      return {
        ok: false,
        error: `${res?.msg || '飞书接口返回错误'}(code=${code})${larkErrorHint(code)}`
      }
    }
    return { ok: true, data: (res?.data ?? ({} as T)) as T }
  } catch (e) {
    return { ok: false, error: larkTransportError(e) }
  }
}

export function noCredentialHint(): string {
  return (
    '未配置飞书应用凭证: 请到 设置 → AI 助手 → 飞书云文档 填写 App ID / App Secret, ' +
    '或在 设置 → IM 渠道 添加一个飞书机器人账号(可直接复用其凭证)。'
  )
}

/** 已知错误码 → 可行动提示(未知码只回显 code/msg) */
export function larkErrorHint(code: number | undefined): string {
  switch (code) {
    case 99991663:
      return ' —— 应用未被授权访问该文档: 请在飞书里打开该文档 → 分享 → 添加协作者, 把本应用加为「可阅读」;'
    case 99991672:
      return (
        ' —— 应用缺少接口权限: 请在开放平台「权限管理」按提示开通所需权限(读: bitable:app:readonly / ' +
        '云文档 docx:document:readonly / 通讯录 contact:user.id:readonly; **写入议题同步还需要 bitable:app**), ' +
        '发布版本后重试; 接口返回的 msg 里通常带一键授权链接;'
      )
    case 99991661:
      return ' —— 应用凭证无效或应用已停用: 请检查 App ID / App Secret, 并确认应用版本已发布;'
    case 40004:
      return (
        ' —— 通讯录可见范围为空或未包含该部门: 请到开放平台「权限管理 → 数据权限」把通讯录可见范围' +
        '设为「全部员工」或指定部门(通常需企业管理员审批), 发布版本后重试;'
      )
    case 1254005:
    case 1254300:
    case 1254302:
      return ' —— 多维表格权限不足: 请把本应用加为该 Base 的协作者(分享 → 添加协作者), 并确认已开通 bitable 只读权限;'
    default:
      return ''
  }
}

/** 网络/HTTP 异常 → 人话(axios 错误带 response) */
export function larkTransportError(e: unknown): string {
  const err = e as {
    message?: string
    response?: { status?: number; data?: { code?: number; msg?: string } }
  }
  const status = err?.response?.status
  const body = err?.response?.data
  const detail =
    body?.msg || body?.code !== undefined ? `${body?.msg ?? ''} (code=${body?.code ?? '-'})` : ''
  if (status === 401 || status === 403) {
    return `飞书接口拒绝访问(HTTP ${status})${detail ? ` ${detail}` : ''}${larkErrorHint(body?.code)}`
  }
  if (status === 404) {
    return `飞书接口 404: token 或 table_id 不存在, 或应用无权看到该资源${detail ? ` ${detail}` : ''}`
  }
  if (status) return `飞书接口请求失败(HTTP ${status})${detail ? ` ${detail}` : ''}`
  return `飞书接口调用失败: ${err?.message ?? String(e)}(请检查网络能否访问 open.feishu.cn)`
}

/** 设置页状态展示: 是否已配置、来源与打码后的 App ID */
export function larkConfigStatus(): {
  configured: boolean
  source: LarkCredSource
  appIdMasked: string
  accountName?: string
  defaultUrl: string
} {
  const cred = getLarkCredential()
  return {
    configured: !!cred.appId && !!cred.appSecret,
    source: cred.source,
    appIdMasked: cred.appId ? `${cred.appId.slice(0, 8)}…${cred.appId.slice(-4)}` : '',
    accountName: cred.accountName,
    defaultUrl: (getConfig('lark.defaultUrl') ?? '').trim()
  }
}
