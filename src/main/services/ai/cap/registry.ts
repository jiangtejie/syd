import { getConfig } from '../../../db/repos/config'
import { findTool } from '../chat/skills'
import { findSoftwareTool } from './software'
import type { ToolDef } from '../chat/skills'

/**
 * 能力注册表(会话工具装配;第三方技能/知识/MCP/自定义工具已下线)。
 *
 * 分层(现仅三组):
 *  - tier 0 核心:元技能(目录/挂载/卸载)恒在,任何会话可用,不占挂载预算;
 *  - tier 1 微信业务:内置 needsWx 工具,绑定账号的会话“默认挂载”;
 *  - tier 2 软件能力:软件自身只读信息(software_status/data_scope 等),按需挂载。
 *
 * 名称唯一性:内置 → 软件能力(冲突时靠前胜出)。挂载粒度为“能力名”。
 */

export type CapGroup = 'core' | 'wechat' | 'software'

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

const TIER_TEXT: Record<CapGroup, string> = {
  core: '核心',
  wechat: '微信业务',
  software: '软件能力'
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
const WHEN_HINT: Record<string, { oneLine: string; when: string }> = {
  query_issues: {
    oneLine: '查本账号记录的问题/客诉(按关键词/状态/严重度)',
    when: '用户问“有没有 XX 问题、待处理客诉、某类投诉记录”时'
  },
  query_group_issues: {
    oneLine: '查指定群(或当前聊天对象)的问题列表,待处理优先',
    when: '用户问某个群近期有哪些问题时'
  },
  search_issue_history: {
    oneLine: '跨群搜索历史客户问题,判断是否重复诉求',
    when: '用户问“这客户之前提过吗/上次怎么处理的”时'
  },
  list_team_members: {
    oneLine: '列出已标记的团队客服成员(自己人)',
    when: '需要区分我方同事发言与客户诉求时'
  },
  monitor_summary: {
    oneLine: '问题监控概览:待办/跟进/紧急/今日新增/疑似',
    when: '用户问监控、待办、紧急情况、KPI 口径数据时'
  },
  customer_lookup: {
    oneLine: '查客户/群资料:显示名/备注/未读/最后消息',
    when: '用户问某个客户或群的基本情况时'
  },
  recent_messages: {
    oneLine: '读指定会话最近消息文本',
    when: '需要知道一个会话刚聊了什么时'
  },
  send_message: {
    oneLine: '发送文本消息给指定客户/群(写操作,执行前需人工确认)',
    when: '用户明确要求给某个客户/群发送微信消息时'
  }
}

/** 软件能力元数据(实现见 software.ts,此处仅提供注册表所需静态描述) */
export const SOFTWARE_CAPS: Array<{
  name: string
  needsWx: boolean
  oneLine: string
  when: string
}> = [
  {
    name: 'software_status',
    needsWx: false,
    oneLine: '软件与账号状态:版本/绑定账号/通道/模型/监控开关',
    when: '用户问“这软件能用吗/连了哪些账号/什么模型/状态如何”时'
  },
  {
    name: 'data_scope',
    needsWx: true,
    oneLine: '数据覆盖范围:会话构成/时间跨度/记录量级(只读)',
    when: '用户问“能看到多少数据、数据全不全、最早到什么时候”时'
  },
  {
    name: 'bi_stats',
    needsWx: true,
    oneLine: '业务统计:问题/会话/消息量与 7 日趋势(只读)',
    when: '用户问“最近业务量、趋势、排行、日报口径”时'
  },
  {
    name: 'im_channels_status',
    needsWx: false,
    oneLine: 'IM 渠道(飞书机器人等)账号连接状态',
    when: '用户问“机器人接了吗、飞书状态如何”时'
  },
  {
    name: 'memory_view',
    needsWx: false,
    oneLine: '查看当前可用的长期上下文来源(只读)',
    when: '用户问“你记得什么、有哪些上下文可用”时'
  },
  {
    name: 'export_preview',
    needsWx: true,
    oneLine: '导出数据范围估算(会话/消息/目标数,不执行导出)',
    when: '用户问“能导出什么、导多少”时'
  }
]

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
      readOnly: name !== 'send_message',
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
    findTool('send_message')
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
  return TIER_TEXT[group]
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
  const groups: CapGroup[] = ['core', 'wechat', 'software']
  const wanted =
    scope === 'mounted'
      ? 'mounted'
      : scope === 'software'
        ? 'software'
        : scope === 'wechat'
          ? 'wechat'
          : 'all'
  for (const g of groups) {
    const caps = listCaps().filter((c) => c.group === g && !c.disabled)
    if (caps.length === 0) continue
    let seg: CapInfo[]
    if (wanted === 'mounted') seg = caps.filter((c) => c.tier === 0 || mounted.has(c.name))
    else if (wanted === 'software') seg = caps.filter((c) => c.group === 'software')
    else if (wanted === 'wechat') seg = caps.filter((c) => c.group === 'wechat')
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
  return findTool(name) ?? findSoftwareTool(name)
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
