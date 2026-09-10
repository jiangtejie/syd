import { isChatRunning, stopChat } from '../ai/chat/service'
import { catalogText } from '../ai/cap/registry'
import { mountedNames } from '../ai/cap/mounts'
import { allowedByTier, getSessionCapTier, TIER_TEXT } from '../ai/cap/tiers'
import {
  finishImAudit,
  findRunningImAudit,
  getImAudit,
  listImAuditByChat
} from '../../db/repos/imAuditRepo'
import { clipForChannel } from './mdToPlain'

/**
 * 飞书会话内的斜杠指令:/help(能力清单)、/tasks、/task <id>、/cancel。
 * 与 LLM 回合解耦:指令零成本、确定性返回,不进模型上下文。
 * 依赖(回复/去表情/日志/审计收尾)由调用方(feishuService)注入,避免本模块反向依赖渠道实现。
 */

export interface FeishuCommandDeps {
  /** 是否绑定微信业务账号 */
  bound: boolean
  /** 回消息(与日常回复同一通道,带分片与降级) */
  reply: (messageId: string, text: string) => Promise<void>
  /** 撤掉"思考中"表情 */
  removeReaction: (messageId: string) => void
  /** 渠道日志 */
  log: (msg: string) => void
  /** 审计/任务行收尾(命令类一行即终态) */
  finishAudit: (patch: { status: 'ok' | 'error'; error?: string }) => void
}

export interface FeishuCommandReq {
  accountId: number
  chatId: string
  sessionId: number
  messageId: string
  /** 绑定业务账号(空 = 通用对话;取消执行时需要) */
  businessWxid: string
  text: string
}

/** 斜杠指令解析:{cmd, arg};非斜杠返回 null */
export function parseSlashCommand(text: string): { cmd: string; arg: string } | null {
  const t = (text ?? '').trim()
  if (!t.startsWith('/')) return null
  const sp = t.search(/\s/)
  const raw = (sp < 0 ? t : t.slice(0, sp)).toLowerCase()
  const cmd = raw.replace(/^\/+/, '')
  const arg = sp < 0 ? '' : t.slice(sp + 1).trim()
  return { cmd, arg }
}

/** /help(能力清单);裸词 help 也认 */
export function isHelpCommand(text: string): boolean {
  const c = parseSlashCommand(text)
  if (c) return ['help', '?', '帮助', '能力'].includes(c.cmd)
  return text.trim().toLowerCase() === 'help'
}

function taskStatusText(s: string): string {
  return s === 'queued'
    ? '排队中'
    : s === 'running'
      ? '执行中'
      : s === 'done' || s === 'ok'
        ? '已完成'
        : s === 'cancelled'
          ? '已取消'
          : '失败'
}

function fmtDur(from: number, to: number | null): string {
  const ms = (to ?? Date.now()) - from
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

/** /help:当前会话「实际可用能力」+ 指令说明(按发送人档位裁剪) */
async function replyCapabilityHelp(deps: FeishuCommandDeps, req: FeishuCommandReq): Promise<void> {
  const tier = getSessionCapTier(req.sessionId)
  let catalog = ''
  try {
    catalog = catalogText({
      mounted: new Set(mountedNames(req.sessionId, deps.bound)),
      bound: deps.bound
    })
  } catch {
    catalog = '(能力目录读取失败)'
  }
  if (tier) {
    catalog = catalog
      .split('\n')
      .filter((line) => {
        const m = /^-\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line.trim())
        return !m || allowedByTier(m[1], tier)
      })
      .join('\n')
  }
  const text = [
    '我是本机「微信客服工作台」的助手。直接用一句话描述任务即可,例如:',
    '· 查一下今天还有哪些待跟进的问题',
    '· 某个群最近有哪些客诉',
    '· 读一下这个飞书表格 <粘贴 /base/ 链接>',
    '',
    '可用指令:',
    '/help 能力清单 · /tasks 最近任务 · /task <id> 任务详情 · /cancel 取消执行中任务',
    '写操作按「工具审批策略」执行:人工审批时会先问你,回复「确认」或「取消」。',
    '',
    `当前会话可用能力(你的权限:${tier ? TIER_TEXT[tier] : '不限'}):`,
    catalog,
    '',
    deps.bound
      ? '写操作(代发微信消息、修改问题状态等)按设置里的「工具审批策略」执行:人工审批 / 完全访问。'
      : '当前渠道未绑定微信业务账号,业务查询会提示先绑定。'
  ].join('\n')
  await deps.reply(req.messageId, text)
}

/** /tasks:本会话最近任务 */
async function replyTaskList(deps: FeishuCommandDeps, req: FeishuCommandReq): Promise<void> {
  const rows = listImAuditByChat(req.accountId, req.chatId, 8)
  if (rows.length === 0) {
    await deps.reply(
      req.messageId,
      '本会话还没有任务记录。直接发一句话描述任务即可(试试 /help 看能力)。'
    )
    return
  }
  const lines = rows.map((t) => {
    const dur = t.startedAt ? ` · ${fmtDur(t.startedAt, t.finishedAt)}` : ''
    const prog = t.status === 'running' && t.progress ? ` · ${t.progress}` : ''
    const err = t.status === 'failed' && t.error ? ` · ${t.error.slice(0, 40)}` : ''
    return `#${t.id} [${taskStatusText(t.status)}]${dur} ${t.text.slice(0, 40)}${prog}${err}`
  })
  await deps.reply(
    req.messageId,
    ['本会话最近任务:', ...lines, '', '查看详情:/task <id> · 取消执行:/cancel'].join('\n')
  )
}

/** /task <id>:单条任务详情 */
async function replyTaskDetail(
  deps: FeishuCommandDeps,
  req: FeishuCommandReq,
  arg: string
): Promise<void> {
  const id = Number(arg.replace(/[^0-9]/g, ''))
  if (!Number.isFinite(id) || id <= 0) {
    await deps.reply(req.messageId, '用法:/task <任务id>(可用 /tasks 查看列表)')
    return
  }
  const t = getImAudit(id)
  if (!t) {
    await deps.reply(req.messageId, `没有找到任务 #${id}。`)
    return
  }
  const parts = [
    `任务 #${t.id} [${taskStatusText(t.status)}]`,
    `指令:${t.text}`,
    t.startedAt ? `耗时:${fmtDur(t.startedAt, t.finishedAt)}` : '',
    t.progress ? `进度:${t.progress}` : '',
    t.error ? `错误:${t.error.slice(0, 200)}` : '',
    t.result ? `\n结果:\n${clipForChannel(t.result, 1200)}` : ''
  ]
  await deps.reply(req.messageId, parts.filter(Boolean).join('\n'))
}

/** /cancel:取消本会话正在执行的任务(停引擎 + 行置 cancelled) */
async function cancelRunningTask(req: FeishuCommandReq): Promise<string> {
  const running = findRunningImAudit(req.accountId, req.chatId)
  if (isChatRunning(req.businessWxid, req.sessionId)) {
    stopChat(req.businessWxid, req.sessionId)
  }
  if (running) {
    try {
      finishImAudit(running.id, { status: 'cancelled' })
    } catch {
      /* 审计失败不影响取消 */
    }
    return `已取消任务 #${running.id}。`
  }
  return '当前没有正在执行的任务。'
}

/**
 * 尝试按指令处理;返回 true 表示已处理(调用方应结束本轮,不再进 LLM)。
 * 未命中任何指令返回 false,由调用方按普通消息入队。
 */
export async function tryHandleFeishuCommand(
  deps: FeishuCommandDeps,
  req: FeishuCommandReq
): Promise<boolean> {
  const done = (error?: string): void => {
    deps.removeReaction(req.messageId)
    deps.finishAudit({ status: error ? 'error' : 'ok', error })
  }
  if (isHelpCommand(req.text)) {
    await replyCapabilityHelp(deps, req)
    done()
    return true
  }
  const slash = parseSlashCommand(req.text)
  if (!slash) return false
  if (['tasks', '任务', 'task-list'].includes(slash.cmd)) {
    await replyTaskList(deps, req)
    done()
    return true
  }
  if (slash.cmd === 'task') {
    await replyTaskDetail(deps, req, slash.arg)
    done()
    return true
  }
  if (['cancel', '取消', 'stop', '停止', 'abort'].includes(slash.cmd)) {
    const msg = await cancelRunningTask(req)
    deps.log(`用户取消任务:${msg}`)
    await deps.reply(req.messageId, msg)
    done('cancelled')
    return true
  }
  return false
}
