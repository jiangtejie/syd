import { app } from 'electron'
import { clipMultiline } from '../../../util/text'
import { getDb } from '../../../db/database'
import { getConfig } from '../../../db/repos/config'
import { listAccounts as listKeyAccounts } from '../../keyStoreService'
import { listImAccounts, rowToAccount } from '../../../db/repos/imRepo'
import { fmtStamp } from '../../../../shared/monitorMetrics'
import { getSessions } from '../../wechat/wxService'
import { listFeedbackIssues } from '../../feedback/analyzer'
import type { ToolCtx, ToolDef } from '../chat/skills'

/**
 * L2「软件能力」:把软件自身信息/只读数据做成大模型可调用的工具。
 * - 全部只读,失败降级为“读取失败:…”,绝不让异常中断对话;
 * - 均不依赖 AI 引擎,直接读 repo/服务;无 wxid 依赖的项 IM 通道也可用;
 * - 注册表元数据见 cap/registry.ts SOFTWARE_CAPS,此处只提供可执行 def。
 */

interface WxSessionLite {
  username: string
  displayName?: string
  nickname?: string
  remark?: string
  isGroup?: boolean
  isOfficialAccount?: boolean
  unreadCount?: number
  lastTimestamp?: number
}

/** 安全的只读区段:读取失败返回占位,不抛错 */
function readSessions(wxid: string): {
  ok?: boolean
  sessions?: WxSessionLite[]
  error?: string
} {
  try {
    const res = getSessions(wxid) as unknown as {
      ok?: boolean
      error?: string
      sessions?: WxSessionLite[]
    }
    return res ?? { ok: false, error: '无返回' }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function imAccountsStatus(): Promise<{ name: string; enabled: boolean; status: string }[]> {
  const { getImStatus } = await import('../../im/feishuService')
  return listImAccounts().map((r) => {
    const item = rowToAccount(r)
    const st = getImStatus(r.id)
    return { name: item.name, enabled: item.enabled, status: st.status ?? '未启动' }
  })
}

function aiChannelText(): string {
  const enabled = getConfig('ai.enabled') === '1' || getConfig('ai.enabled') === 'true'
  const model = (getConfig('ai.model') || '').trim()
  const baseUrl = (getConfig('ai.baseUrl') || '').trim()
  const hasKey = !!(getConfig('ai.apiKey') || '').trim()
  let host = '-'
  try {
    host = new URL(baseUrl).host || baseUrl || '-'
  } catch {
    host = baseUrl || '-'
  }
  return `AI 通道:${enabled ? '已启用' : '未启用'};模型:${model || '(未配置)'};服务:${host};密钥:${hasKey ? '已配置' : '缺失'}`
}

function csStats(): { chats: number; msgs: number; issues: number } {
  const db = getDb()
  const one = (sql: string, ...args: unknown[]): number => {
    const row = db.prepare(sql).get(...args) as { n?: number } | undefined
    return row?.n ?? 0
  }
  return {
    chats: one(`SELECT COUNT(*) AS n FROM chat_session`),
    msgs: one(`SELECT COUNT(*) AS n FROM chat_message`),
    issues: one(`SELECT COUNT(*) AS n FROM issue_feedback`)
  }
}

/** 问题聚合(按绑定账号) */
function issueAgg(
  wxid: string,
  days: number
): {
  open: number
  done: number
  doubt: number
  urgent: number
  overdue: number
  newIn: number
} {
  const list = listFeedbackIssues(wxid)
  const from = Date.now() - days * 86_400_000
  let open = 0
  let done = 0
  let doubt = 0
  let urgent = 0
  let overdue = 0
  let newIn = 0
  for (const it of list) {
    if (it.status === 'open') {
      open++
      if (it.needConfirm) doubt++
      if (it.severity === '紧急') urgent++
      if (it.followUpOverdue) overdue++
    } else if (it.status === 'done') {
      done++
    }
    if ((it.createdAt ?? 0) >= from) newIn++
  }
  return { open, done, doubt, urgent, overdue, newIn }
}

function defOf(
  name: string,
  needsWx: boolean,
  description: string,
  run: (wxid: string) => Promise<string> | string
): ToolDef {
  return {
    name,
    kind: 'builtin',
    needsWx,
    description,
    run: async (ctx: ToolCtx) => {
      try {
        return clipMultiline(await run((ctx.wxid || '').trim()), 4000)
      } catch (e) {
        return `执行失败:${e instanceof Error ? e.message : String(e)}`
      }
    }
  }
}

/** 全部软件能力 defs(注册表目录与执行链共用) */
export function softwareToolDefs(): ToolDef[] {
  return [
    softwareStatusDef(),
    dataScopeDef(),
    biStatsDef(),
    imChannelsDef(),
    memoryViewDef(),
    exportPreviewDef()
  ]
}

export function findSoftwareTool(name: string): ToolDef | undefined {
  return softwareToolDefs().find((d) => d.name === name)
}

function softwareStatusDef(): ToolDef {
  return defOf(
    'software_status',
    false,
    '软件自身状态摘要:版本/微信账号绑定/IM 通道/AI 通道/监控开关。args:{}',
    async () => {
      const accs = listKeyAccounts()
      const cs = csStats()
      const im = await imAccountsStatus()
      const lines = [
        `软件版本:${app.getVersion?.() ?? '-'}`,
        aiChannelText(),
        `微信账号:${accs.length} 个(有效 ${accs.filter((a) => a.status === 'valid').length} 个)` +
          (accs.length > 0
            ? '\n' +
              accs
                .map((a) => `- ${a.wxid} 状态:${a.status ?? '-'} 来源:${a.source ?? '-'}`)
                .join('\n')
            : ''),
        `监控调度:自动扫描 ${getConfig('issue.autoScan.enabled') === '1' ? '开' : '关'};超时盯办 ${getConfig('issue.escalate.enabled') === '1' ? '开' : '关'}(未指派 ${getConfig('issue.escalateUnassignedHours') || 4}h/紧急 ${getConfig('issue.escalateUrgentHours') || 1}h)`,
        `IM 渠道:${im.length} 个账号` +
          (im.length > 0
            ? '\n' +
              im
                .map((a) => `- ${a.name} ${a.enabled ? '启用' : '停用'} 状态:${a.status}`)
                .join('\n')
            : ''),
        `CS 库规模:AI 会话 ${cs.chats}、消息 ${cs.msgs}、问题记录 ${cs.issues}`
      ]
      return lines.join('\n')
    }
  )
}

function dataScopeDef(): ToolDef {
  return defOf(
    'data_scope',
    true,
    '微信侧与本地库数据覆盖范围(只读):会话构成/未读/活跃度/AI 会话与问题记录量/时间跨度。args:{}',
    async (wxid) => {
      const sessions = readSessions(wxid)
      const db = getDb()
      let chatSpan = ''
      try {
        const row = db
          .prepare(
            `SELECT COUNT(*) AS n, MIN(created_at) AS lo, MAX(created_at) AS hi FROM issue_feedback WHERE wxid = ?`
          )
          .get(wxid) as { n: number; lo: number | null; hi: number | null }
        chatSpan = `问题记录 ${row.n} 条(${fmtStamp(row.lo ?? 0)} ~ ${fmtStamp(row.hi ?? 0)})`
      } catch {
        chatSpan = '问题记录:(读取失败)'
      }
      const cs = csStats()
      if (!sessions.ok || !sessions.sessions) {
        return (
          `微信数据:(未就绪 ${sessions.error ?? '账号未连接或数据未解密'})\n` +
          `CS 库:AI 会话 ${cs.chats}、消息 ${cs.msgs}\n${chatSpan}`
        )
      }
      const all = sessions.sessions
      const groups = all.filter((s) => s.isGroup)
      const users = all.filter((s) => !s.isGroup && !s.isOfficialAccount)
      const unread = all.reduce((n, s) => n + (s.unreadCount ?? 0), 0)
      const lastAct = all.reduce((m, s) => Math.max(m, s.lastTimestamp ?? 0), 0)
      return (
        `微信会话:共 ${all.length}(群 ${groups.length} / 个人 ${users.length} / 其它 ${all.length - groups.length - users.length});未读合计 ${unread};最近活跃 ${fmtStamp(lastAct)}\n` +
        `(口径:仅能列出已解密会话及其最后消息时间,无法全量扫描历史最早时间)\n` +
        `CS 库:AI 会话 ${cs.chats}、消息 ${cs.msgs}\n${chatSpan}`
      )
    }
  )
}

function biStatsDef(): ToolDef {
  return defOf(
    'bi_stats',
    true,
    '业务统计(只读):问题 待办/跟进/紧急/今日/近7日/疑似 + 高频群 + 活跃会话。args:{}',
    async (wxid) => {
      const agg = issueAgg(wxid, 7)
      const dayStart = new Date()
      dayStart.setHours(0, 0, 0, 0)
      const today = issueAgg(wxid, 1)
      // 高频问题群 Top5
      let topGroups: string[] = []
      try {
        const freq = new Map<string, number>()
        for (const it of listFeedbackIssues(wxid)) {
          const g = it.groupName || it.groupUsername || ''
          if (g) freq.set(g, (freq.get(g) ?? 0) + 1)
        }
        topGroups = [...freq.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([g, n]) => `${g}×${n}`)
      } catch {
        topGroups = []
      }
      let activeSessions = 0
      const sessions = readSessions(wxid)
      if (sessions.ok && sessions.sessions) {
        activeSessions = sessions.sessions.filter(
          (s) => (s.lastTimestamp ?? 0) >= dayStart.getTime()
        ).length
      }
      const lines = [
        `问题(近7日):待处理/未回复 ${agg.open} 条;已闭环 ${agg.done};疑似待确认 ${agg.doubt};紧急待办 ${agg.urgent};跟进超时 ${agg.overdue};7 日新增 ${agg.newIn}(今日 ${today.newIn})`,
        `活跃:今日有消息的微信会话 ${activeSessions} 个`,
        topGroups.length > 0 ? `高频问题群:${topGroups.join('、')}` : '',
        '(口径:问题=监控问题库;会话=已解密微信会话的当日最后消息)'
      ]
      return lines.filter(Boolean).join('\n')
    }
  )
}

function imChannelsDef(): ToolDef {
  return defOf(
    'im_channels_status',
    false,
    'IM 渠道(飞书机器人)账号与连接状态、外部会话映射数。args:{}',
    async () => {
      const im = await imAccountsStatus()
      if (im.length === 0) return '当前没有配置 IM 渠道账号。'
      const db = getDb()
      const lines: string[] = []
      for (const r of listImAccounts()) {
        const name = r.name
        const cnt = (
          db.prepare(`SELECT COUNT(*) AS n FROM im_chat_map WHERE account_id = ?`).get(r.id) as {
            n: number
          }
        ).n
        const cur = im.find((a) => a.name === name)
        lines.push(
          `- ${name} ${r.enabled ? '启用' : '停用'} 连接:${cur?.status ?? '-'} 外部会话映射 ${cnt} 个`
        )
      }
      return lines.join('\n')
    }
  )
}

function memoryViewDef(): ToolDef {
  return defOf(
    'memory_view',
    false,
    '查看当前会话的长期上下文来源(只读):常驻记忆功能已下线,上下文仅来自本会话历史与项目知识注入。args:{}',
    async () => '常驻记忆/知识库功能已下线:当前上下文只包含本会话历史与智能体人设,没有跨会话记忆。'
  )
}

function exportPreviewDef(): ToolDef {
  return defOf(
    'export_preview',
    true,
    '估算可导出数据范围(只读,不执行导出):会话构成与消息量级、AI 会话、问题记录。args:{}',
    async (wxid) => {
      const sessions = readSessions(wxid)
      const db = getDb()
      let aiMsgs = 0
      let aiChats = 0
      try {
        const row = db
          .prepare(
            `SELECT COUNT(*) AS m FROM chat_message WHERE session_id IN (SELECT id FROM chat_session WHERE wxid = ?)`
          )
          .get(wxid) as { m: number }
        aiMsgs = row?.m ?? 0
        aiChats = listImSessionsCount(wxid)
      } catch {
        /* ignore */
      }
      const issueCnt = (
        db.prepare(`SELECT COUNT(*) AS n FROM issue_feedback WHERE wxid = ?`).get(wxid) as {
          n: number
        }
      ).n
      const head = [
        '可导出内容(全部在 导出 页人工执行,AI 不直接导出):',
        `微信会话 ${sessions.ok && sessions.sessions ? sessions.sessions.length : '(数据未就绪)'} 个(含群聊;支持按会话导出 txt/html/json)`,
        `AI 助手会话 ${aiChats} 个、消息约 ${aiMsgs} 条(cs 库)`,
        `问题记录 ${issueCnt} 条(监控问题,可随会话导出或单独汇总)`
      ]
      return head.join('\n')
    }
  )
}

function listImSessionsCount(wxid: string): number {
  try {
    const row = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM chat_session WHERE wxid = ?`)
      .get(wxid) as { n: number }
    return row?.n ?? 0
  } catch {
    return 0
  }
}
