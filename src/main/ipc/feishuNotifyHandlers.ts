import { ipcMain, shell } from 'electron'
import {
  addFeishuNotifyTarget,
  getFeishuNotifyConfig,
  recentFeishuSends,
  removeFeishuNotifyTarget,
  sendFeishuGroupIssues,
  sendFeishuTestMessage,
  setFeishuNotifyEnabled,
  setFeishuNotifyEvent,
  type FeishuNotifyEvent
} from '../services/lark/notify'
import { getDigestConfig, sendDigestNow, setDigestConfig } from '../services/feedback/digest'
import { listBotChats, resolveOpenIdByEmail } from '../services/lark/im'
import { getContactScope, listDepartmentUsers, listDepartments } from '../services/lark/contact'
import { larkConfigStatus } from '../services/lark/client'
import { listRecentImAudit } from '../db/repos/imAuditRepo'

/**
 * 飞书通知 IPC(cs:feishu:notify:*):设置页配置接收目标、事件开关与测试发送。
 * 凭证复用 设置 → AI 助手 → 飞书云文档 或 IM 渠道的飞书账号(见 services/lark/client.ts)。
 */
export function registerFeishuNotifyHandlers(): void {
  ipcMain.handle('cs:feishu:notify:get', () => {
    try {
      return {
        ok: true as const,
        config: getFeishuNotifyConfig(),
        credential: larkConfigStatus(),
        recent: recentFeishuSends(10)
      }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : '读取飞书通知配置失败' }
    }
  })

  // ── 每日日报（与实时告警分开开关，共用接收目标）──
  ipcMain.handle('cs:feishu:digest:get', () => {
    try {
      return { ok: true as const, config: getDigestConfig() }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : '读取日报配置失败' }
    }
  })

  ipcMain.handle(
    'cs:feishu:digest:set',
    (_e, patch: { enabled?: boolean; time?: string; includeAgent?: boolean } = {}) => {
      try {
        const r = setDigestConfig(patch)
        return r.ok
          ? { ok: true as const, config: r.config }
          : { ok: false as const, error: r.error, config: r.config }
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : '保存失败' }
      }
    }
  )

  /** 立即发一条（设置页预览）：markSent=false 不占用「今天已发」标记，到点仍会正常发 */
  ipcMain.handle('cs:feishu:digest:send', async (_e, wxid: string, markSent?: boolean) => {
    if (!wxid) return { ok: false as const, error: '缺少账号（同步需要账号作用域）' }
    try {
      const r = await sendDigestNow(wxid, { markSent: markSent === true })
      return { ...r, config: getDigestConfig() }
    } catch (e) {
      return {
        ok: false as const,
        sent: 0,
        text: '',
        error: e instanceof Error ? e.message : '发送失败'
      }
    }
  })

  ipcMain.handle('cs:feishu:notify:setEnabled', (_e, on: boolean) => {
    try {
      setFeishuNotifyEnabled(!!on)
      return { ok: true as const, config: getFeishuNotifyConfig() }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : '保存失败' }
    }
  })

  ipcMain.handle('cs:feishu:notify:setEvent', (_e, evt: string, on: boolean) => {
    const name: FeishuNotifyEvent | null =
      evt === 'issue_new' || evt === 'issue_escalate' ? evt : null
    if (!name) return { ok: false as const, error: '未知事件' }
    try {
      setFeishuNotifyEvent(name, !!on)
      return { ok: true as const, config: getFeishuNotifyConfig() }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : '保存失败' }
    }
  })

  ipcMain.handle(
    'cs:feishu:notify:addTarget',
    (_e, input: { kind: 'chat' | 'user'; id: string; name?: string }) => {
      try {
        const kind = input?.kind === 'chat' ? 'chat' : 'user'
        const r = addFeishuNotifyTarget({ kind, id: String(input?.id ?? ''), name: input?.name })
        return r.ok
          ? { ok: true as const, targets: r.targets, config: getFeishuNotifyConfig() }
          : { ok: false as const, error: r.error ?? '添加失败' }
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : '添加失败' }
      }
    }
  )

  ipcMain.handle('cs:feishu:notify:removeTarget', (_e, kind: 'chat' | 'user', id: string) => {
    try {
      const r = removeFeishuNotifyTarget(kind === 'chat' ? 'chat' : 'user', String(id ?? ''))
      return { ok: true as const, targets: r.targets, config: getFeishuNotifyConfig() }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : '删除失败' }
    }
  })

  ipcMain.handle('cs:feishu:notify:test', async () => {
    try {
      const r = await sendFeishuTestMessage()
      return r.ok
        ? { ok: true as const, sent: r.sent, recent: recentFeishuSends(10) }
        : { ok: false as const, error: r.error ?? '发送失败' }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : '发送失败' }
    }
  })

  // 工作台「群问题」面板的「发到飞书」：把本群未闭环问题摘要发到已配置的目标（写审计、受日限额）
  ipcMain.handle(
    'cs:feishu:notify:sendGroupIssues',
    async (_e, wxid: string, chatroom: string, targetName?: string) => {
      try {
        const r = await sendFeishuGroupIssues({
          wxid: String(wxid ?? ''),
          chatroom: String(chatroom ?? ''),
          targetName: targetName ? String(targetName) : undefined
        })
        return r.ok
          ? { ok: true as const, sent: r.sent, count: r.count, targets: r.targets }
          : { ok: false as const, error: r.error ?? '发送失败', count: r.count }
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : '发送失败' }
      }
    }
  )

  ipcMain.handle('cs:feishu:notify:listChats', async () => {
    try {
      const r = await listBotChats()
      return r.ok
        ? { ok: true as const, chats: r.data.chats }
        : { ok: false as const, error: r.error }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : '获取群列表失败' }
    }
  })

  /**
   * IM 审计/任务(桌面端只读,同一张 im_audit):
   *   onlyTasks=true → 只看任务(message/command);false → 含被接收策略拒绝的消息。
   */
  ipcMain.handle('cs:feishu:audit:list', (_e, limit?: number, onlyTasks?: boolean) => {
    try {
      return {
        ok: true as const,
        logs: listRecentImAudit(Number(limit) || 50, { onlyTasks: onlyTasks === true })
      }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : '读取审计失败' }
    }
  })

  // ── 组织联系人(通讯录) ──

  ipcMain.handle('cs:feishu:contact:scope', async () => {
    try {
      const r = await getContactScope()
      return r.ok ? { ok: true as const, ...r.data } : { ok: false as const, error: r.error }
    } catch (e) {
      return {
        ok: false as const,
        error: e instanceof Error ? e.message : '读取通讯录可见范围失败'
      }
    }
  })

  ipcMain.handle('cs:feishu:contact:departments', async (_e, parentId: string) => {
    try {
      const r = await listDepartments(String(parentId ?? '0') || '0')
      return r.ok
        ? { ok: true as const, departments: r.data.departments, hasMore: r.data.hasMore }
        : { ok: false as const, error: r.error }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : '读取部门失败' }
    }
  })

  ipcMain.handle('cs:feishu:contact:users', async (_e, deptId: string, pageToken?: string) => {
    try {
      const r = await listDepartmentUsers(String(deptId ?? '0') || '0', {
        pageToken: typeof pageToken === 'string' ? pageToken : undefined
      })
      return r.ok
        ? {
            ok: true as const,
            users: r.data.users,
            hasMore: r.data.hasMore,
            pageToken: r.data.pageToken
          }
        : { ok: false as const, error: r.error }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : '读取部门成员失败' }
    }
  })

  /** 打开开放平台授权页(仅允许 open.feishu.cn) */
  ipcMain.handle('cs:feishu:contact:openAuth', async (_e, url: string) => {
    const target = String(url ?? '').trim()
    if (!/^https:\/\/open\.feishu\.cn\//.test(target)) {
      return { ok: false as const, error: '仅允许打开飞书开放平台链接' }
    }
    await shell.openExternal(target)
    return { ok: true as const }
  })

  ipcMain.handle('cs:feishu:notify:resolveUser', async (_e, email: string) => {
    try {
      const r = await resolveOpenIdByEmail(String(email ?? ''))
      return r.ok
        ? { ok: true as const, openId: r.data.openId }
        : { ok: false as const, error: r.error }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : '解析失败' }
    }
  })
}
