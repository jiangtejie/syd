import { getConfig } from '../../../db/repos/config'
import { findTool } from '../chat/skills'
import { findSoftwareTool } from './software'
import { findLarkTool } from '../../lark/tools'
import { findWsTool, isWsWriteTool } from './wsTools'
import type { ToolDef } from '../chat/skills'
import { GROUP_TEXT, LARK_CAPS, SOFTWARE_CAPS, WHEN_HINT, WS_CAPS, type CapGroup } from './catalog'

/**
 * 能力注册表(会话工具装配;第三方技能/知识/MCP/自定义工具已下线)。
 *
 * 分层(现四组):
 *  - tier 0 核心:元技能(目录/挂载/卸载)恒在,任何会话可用,不占挂载预算;
 *  - tier 1 微信业务:内置 needsWx 工具,绑定账号的会话“默认挂载”;
 *  - tier 2 软件能力:软件自身只读信息(software_status/data_scope 等),按需挂载;
 *  - tier 2 飞书云文档:只读读取飞书多维表格/云文档(lark_*),按需挂载(需先配置飞书应用凭证)。
 *
 * 名称唯一性:内置 → 软件能力 → 飞书云文档(冲突时靠前胜出)。挂载粒度为“能力名”。
 */

export type { CapGroup } from './catalog'

export interface CapInfo {
  /** 能力名(挂载/卸载/目录使用) */
  name: string
  /** 0=核心常驻,1=微信业务,2=软件能力 */
  tier: 0 | 1 | 2
  group: CapGroup
  kind: 'tool'
  readOnly: boolean
  /** 依赖已绑定微信账号(仅 wxid 非空会话可挂载/执行) */
  needsWx?: boolean
  /** 目录行:一句话用途 */
  oneLine: string
  /** 何时使用(触发场景,给模型) */
  when: string
  /** 是否被用户停用(config cap.disable 逗号列表) */
  disabled: boolean
}

const TIER_NO: Record<number, string> = { 0: 'L0', 1: 'L1', 2: 'L2' }

/** 用户停用集合(config cap.disable = 'a,b') */
function disabledNames(): Set<string> {
  const raw = (getConfig('cap.disable') ?? '').trim()
  return new Set(
    raw
      ? raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : []
  )
}

/** 会话挂载的“名称→说明”元数据(供目录行) */

/** 软件能力元数据(实现见 software.ts,此处仅提供注册表所需静态描述) */

/** 飞书云文档能力元数据(实现见 services/lark/tools.ts,此处仅提供注册表所需静态描述) */

/** 工作区文件能力元数据(实现见 cap/wsTools.ts);写类工具执行前走审批桥 */

/**
 * 能力清单缓存:每轮工具调用会多次走到这里(capNameOfDef/isCapDisabled/expandMounted…),
 * 每次都重建 17 条 CapInfo + 读一次 app_config。以 cap.disable 配置值为键失效即可。
 */
let capsCache: { key: string; caps: CapInfo[] } | null = null

/** 全部能力清单(按 cap.disable 配置缓存) */
export function listCaps(): CapInfo[] {
  const key = getConfig('cap.disable') ?? ''
  if (capsCache && capsCache.key === key) return capsCache.caps
  const disabled = disabledNames()
  const out: CapInfo[] = []

  const push = (
    name: string,
    tier: CapInfo['tier'],
    group: CapGroup,
    needsWx: boolean,
    oneLine: string,
    when: string
  ): void => {
    out.push({
      name,
      tier,
      group,
      kind: 'tool',
      // 写类能力一律标成非只读（此前只认 send_message，feishu_send_message 会被误标成只读）
      readOnly: !isWriteCap(name),
      needsWx,
      oneLine,
      when,
      disabled: disabled.has(name)
    })
  }

  // L0 核心元技能(恒在)
  push(
    'list_capabilities',
    0,
    'core',
    false,
    '查看能力目录(按需列出全部可挂载能力)',
    '不确定当前可用什么能力、或要查某类能力是否存在时'
  )
  push(
    'mount_capability',
    0,
    'core',
    false,
    '把某项能力挂载进当前会话',
    '确认任务需要某项未挂载能力时,先看目录再挂载'
  )
  push(
    'unmount_capability',
    0,
    'core',
    false,
    '从当前会话卸载某项已挂载能力',
    '某能力不再需要时,或需要腾出上下文预算时'
  )

  // L1 微信业务(绑定会话默认挂载)
  for (const def of [
    findTool('query_issues'),
    findTool('query_group_issues'),
    findTool('search_issue_history'),
    findTool('list_team_members'),
    findTool('monitor_summary'),
    findTool('customer_lookup'),
    findTool('recent_messages'),
    findTool('send_message'),
    findTool('resolve_issue'),
    findTool('stall_issue'),
    findTool('assign_issue')
  ]) {
    if (!def) continue
    const hint = WHEN_HINT[def.name]
    push(
      def.name,
      1,
      'wechat',
      true,
      hint?.oneLine ?? def.description.slice(0, 60),
      hint?.when ?? '微信业务问题相关时'
    )
  }

  // L2 软件能力
  for (const c of SOFTWARE_CAPS) {
    push(c.name, 2, 'software', c.needsWx, c.oneLine, c.when)
  }

  // L2 飞书云文档(只读,按需挂载)
  for (const c of LARK_CAPS) {
    push(c.name, 2, 'cloud', false, c.oneLine, c.when)
  }

  // L2 工作区文件(需会话/默认工作区;写类工具走审批)
  for (const c of WS_CAPS) {
    if (!findWsTool(c.name)) continue
    push(c.name, 2, 'workspace', false, c.oneLine, c.when)
  }

  capsCache = { key, caps: out }
  return out
}

/** 能力名是否在用户停用列表 */
export function isCapDisabled(name: string): boolean {
  return disabledNames().has(name)
}

export function tierTag(tier: CapInfo['tier']): string {
  return TIER_NO[tier] ?? 'L2'
}

export function groupText(group: CapGroup): string {
  return GROUP_TEXT[group]
}

/** 工具 def 名 → 归属能力名(挂载校验/使用标记用);核心元技能返回 undefined */
export function capNameOfDef(defName: string): string | undefined {
  const cap = listCaps().find((c) => c.name === defName)
  return cap ? (cap.tier === 0 ? undefined : cap.name) : undefined
}

/** 目录文本(给 list_capabilities;含挂载态与账号约束标注) */
export function catalogText(opts: {
  mounted: Set<string>
  bound: boolean
  scope?: string
}): string {
  const { mounted, bound, scope = 'all' } = opts
  const rows: string[] = []
  const pushRow = (c: CapInfo): void => {
    const state = c.tier === 0 ? '常驻' : mounted.has(c.name) ? '●已挂载' : '○未挂载'
    const needWx = c.needsWx && !bound ? ' [需绑定账号]' : ''
    rows.push(
      `- ${c.name}(${tierTag(c.tier)}·${groupText(c.group)}${state})${needWx} ${c.oneLine};适用:${c.when}`
    )
  }
  const groups: CapGroup[] = ['core', 'wechat', 'software', 'cloud', 'workspace']
  const wanted =
    scope === 'mounted'
      ? 'mounted'
      : scope === 'software'
        ? 'software'
        : scope === 'wechat'
          ? 'wechat'
          : scope === 'cloud'
            ? 'cloud'
            : scope === 'workspace'
              ? 'workspace'
              : 'all'
  for (const g of groups) {
    const caps = listCaps().filter((c) => c.group === g && !c.disabled)
    if (caps.length === 0) continue
    let seg: CapInfo[]
    if (wanted === 'mounted') seg = caps.filter((c) => c.tier === 0 || mounted.has(c.name))
    else if (wanted === 'software') seg = caps.filter((c) => c.group === 'software')
    else if (wanted === 'wechat') seg = caps.filter((c) => c.group === 'wechat')
    else if (wanted === 'cloud') seg = caps.filter((c) => c.group === 'cloud')
    else if (wanted === 'workspace') seg = caps.filter((c) => c.group === 'workspace')
    else seg = caps
    if (seg.length === 0) continue
    rows.push(`【${groupText(g)}】`)
    for (const c of seg) pushRow(c)
  }
  let text = rows.join('\n')
  if (text.length > 3500) text = `${text.slice(0, 3500)}\n…(目录过长已截断,可按 scope 细分)`
  return text || '(暂无可用能力)'
}

/** 能力名(单工具能力)解析为 ToolDef */
export function resolveCapDef(name: string): ToolDef | undefined {
  return findTool(name) ?? findSoftwareTool(name) ?? findLarkTool(name) ?? findWsTool(name)
}

/** 能力是否为写操作(供审批判定;工作区写类工具历史上由 isWsWriteTool 标记) */
export function isWriteCap(name: string): boolean {
  return resolveCapDef(name)?.confirm === true || isWsWriteTool(name)
}

/** 展开挂载集合 → 可见工具 defs(失效项跳过并回报) */
export async function expandMounted(
  names: string[],
  opts: { bound: boolean }
): Promise<{ defs: ToolDef[]; errors: string[] }> {
  const defs: ToolDef[] = []
  const errors: string[] = []
  const caps = listCaps()
  for (const name of names) {
    const cap = caps.find((c) => c.name === name)
    if (!cap || cap.disabled) {
      errors.push(`${name}:不存在或已停用`)
      continue
    }
    if (cap.needsWx && !opts.bound) {
      errors.push(`${name}:需绑定微信账号`)
      continue
    }
    const def = resolveCapDef(name)
    if (def) defs.push(def)
    else errors.push(`${name}:当前不可解析`)
  }
  return { defs, errors }
}
