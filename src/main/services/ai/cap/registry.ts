import { getConfig } from '../../../db/repos/config'
import { listMcpServers } from '../../../db/repos/mcpRepo'
import { listEnabledSkills } from '../../../db/repos/skillsRepo'
import { findTool } from '../chat/skills'
import { findCustomTool, listCustomToolDefs } from '../chat/customTools'
import { findPackTool } from '../chat/skillsPack'
import { defsOfServerCap } from '../chat/mcp'
import { findSoftwareTool } from './software'
import type { ToolDef } from '../chat/skills'

/**
 * 能力注册表(分层渐进式加载的“目录”):统一元数据/优先级/开关/挂载展开。
 *
 * 分层:
 *  - tier 0 核心:元技能(目录/挂载/卸载)恒在,任何会话可用,不占挂载预算;
 *  - tier 1 微信业务:内置 needsWx 工具,绑定账号的会话“默认挂载”;
 *  - tier 2 软件/自定义:软件自身能力与自定义 HTTP 工具,默认挂载(可卸载)或按需挂载;
 *  - tier 3 外部:第三方技能包(tool/knowledge)与 MCP,目录可见,按需挂载。
 *
 * 名称唯一性与优先级(同名冲突时靠前胜出,与历史执行链一致):
 *   内置 → 软件能力 → MCP → 自定义工具 → 第三方技能包
 * 挂载粒度为“能力名”:单工具能力=工具名;MCP 服务器为组能力(mcp@名称,挂载时展开其全部工具);
 * knowledge 技能为知识能力(knowledge:包名,挂载后注入知识文本,不注册工具)。
 */

export type CapGroup = 'core' | 'wechat' | 'software' | 'custom' | 'skill' | 'mcp'

export interface CapInfo {
  /** 能力名(挂载/卸载/目录使用) */
  name: string
  /** 0=核心常驻,1=微信业务,2=软件/自定义,3=外部 */
  tier: 0 | 1 | 2 | 3
  group: CapGroup
  kind: 'tool' | 'group' | 'knowledge'
  readOnly: boolean
  confirm?: boolean
  /** 依赖已绑定微信账号(仅 wxid 非空会话可挂载/执行) */
  needsWx?: boolean
  /** 目录行:一句话用途 */
  oneLine: string
  /** 何时使用(触发场景,给模型) */
  when: string
  /** 是否被用户停用(config cap.disable 逗号列表) */
  disabled: boolean
  /** 组能力可解析出的工具数(仅展示,不触发握手) */
  childCount?: number
}

const TIER_TEXT: Record<CapGroup, string> = {
  core: '核心',
  wechat: '微信业务',
  software: '软件能力',
  custom: '自定义工具',
  skill: '第三方技能',
  mcp: 'MCP'
}

const TIER_NO: Record<number, string> = { 0: 'L0', 1: 'L1', 2: 'L2', 3: 'L3' }

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
    oneLine: '查看智能体常驻记忆清单(只读)',
    when: '用户问“你记得什么、记忆里有什么”时'
  },
  {
    name: 'export_preview',
    needsWx: true,
    oneLine: '导出数据范围估算(会话/消息/目标数,不执行导出)',
    when: '用户问“能导出什么、导多少”时'
  }
]

/** 全部能力清单(每次实时聚合;mcp 工具数量不握手,按服务器静态行展示) */
export function listCaps(): CapInfo[] {
  const disabled = disabledNames()
  const out: CapInfo[] = []

  const push = (
    name: string,
    tier: CapInfo['tier'],
    group: CapGroup,
    kind: CapInfo['kind'],
    needsWx: boolean,
    oneLine: string,
    when: string,
    opts: { readOnly?: boolean; confirm?: boolean; childCount?: number } = {}
  ): void => {
    out.push({
      name,
      tier,
      group,
      kind,
      readOnly: opts.readOnly ?? kind !== 'group',
      confirm: opts.confirm,
      needsWx,
      oneLine,
      when,
      disabled: disabled.has(name),
      childCount: opts.childCount
    })
  }

  // L0 核心元技能(恒在)
  push(
    'list_capabilities',
    0,
    'core',
    'tool',
    false,
    '查看能力目录(按需列出全部可挂载能力)',
    '不确定当前可用什么能力、或要查某类能力是否存在时'
  )
  push(
    'mount_capability',
    0,
    'core',
    'tool',
    false,
    '把某项 L1-L3 能力挂载进当前会话',
    '确认任务需要某项未挂载能力时,先看目录再挂载'
  )
  push(
    'unmount_capability',
    0,
    'core',
    'tool',
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
    findTool('recent_messages')
  ]) {
    if (!def) continue
    const hint = WHEN_HINT[def.name]
    push(
      def.name,
      1,
      'wechat',
      'tool',
      true,
      hint?.oneLine ?? def.description.slice(0, 60),
      hint?.when ?? '微信业务问题相关时'
    )
  }

  // L2 软件能力
  for (const c of SOFTWARE_CAPS) {
    push(c.name, 2, 'software', 'tool', c.needsWx, c.oneLine, c.when, { readOnly: true })
  }

  // L2 自定义 HTTP 工具
  for (const d of listCustomToolDefs()) {
    push(
      d.name,
      2,
      'custom',
      'tool',
      false,
      d.description.slice(0, 90),
      '用户配置的自定义 HTTP 工具对应场景',
      {
        readOnly: !d.confirm,
        confirm: d.confirm
      }
    )
  }

  // L3 第三方技能包
  for (const { name: pkgName, manifest } of listEnabledSkills()) {
    const capName = manifest.name || pkgName
    if (manifest.kind === 'knowledge' && manifest.knowledge?.trim()) {
      const cap = `knowledge:${capName}`
      push(
        cap,
        3,
        'skill',
        'knowledge',
        false,
        `知识「${capName}」:${manifest.description.slice(0, 60)}`,
        `问及「${capName}」相关内容、制度/话术/操作规范时`
      )
    } else if (manifest.kind === 'tool' && manifest.tool?.url) {
      push(
        capName,
        3,
        'skill',
        'tool',
        false,
        manifest.description.slice(0, 90),
        `第三方技能「${capName}」声明的场景`,
        { readOnly: false, confirm: true }
      )
    }
  }

  // L3 MCP 服务器(组能力;挂载时才握手展开工具)
  for (const s of listMcpServers().filter((x) => x.enabled)) {
    push(
      `mcp@${s.name}`,
      3,
      'mcp',
      'group',
      false,
      `MCP 服务器「${s.name}」(启用后懒加载其工具)`,
      `需要 ${s.name} 提供的${s.name.includes('数据库') || s.name.includes('DB') ? '数据查询' : '外部能力'}时`,
      { readOnly: false, confirm: !!s.confirm }
    )
  }

  return out
}

export function lookupCap(name: string): CapInfo | undefined {
  const cap = listCaps().find((c) => c.name === name)
  return cap && !cap.disabled ? cap : undefined
}

/** 能力名是否在用户停用列表 */
export function isCapDisabled(name: string): boolean {
  return disabledNames().has(name)
}

export function tierTag(tier: CapInfo['tier']): string {
  return TIER_NO[tier] ?? 'L3'
}

export function groupText(group: CapGroup): string {
  return TIER_TEXT[group]
}

/** 工具 def 名 → 归属能力名(挂载校验/使用标记用);核心元技能返回 undefined */
export function capNameOfDef(defName: string): string | undefined {
  const caps = listCaps()
  const direct = caps.find((c) => c.kind === 'tool' && c.name === defName)
  if (direct) return direct.tier === 0 ? undefined : direct.name
  // MCP 组能力工具:mcp_{serverId}_{safeName}
  const m = /^mcp_(\d+)_/.exec(defName)
  if (m) {
    const srv = listMcpServers().find((s) => s.enabled && String(s.id) === m[1])
    if (srv) return `mcp@${srv.name}`
  }
  return undefined
}

/** 能力是否核心常驻(不可卸载/不占预算) */
export function isCoreCapability(name: string): boolean {
  return listCaps().some((c) => c.name === name && c.tier === 0)
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
    const state = c.tier === 0 ? '常驻' : mounted.has(c.name) ? '●已挂载' : bound ? '○未挂载' : '○'
    const needWx = c.needsWx && !bound ? ' [需绑定账号]' : c.needsWx ? ' [账号数据]' : ''
    const ro = c.readOnly ? ' [只读]' : ' [可执行]'
    const confirm = c.confirm ? ' [需确认]' : ''
    rows.push(
      `- ${c.name}(${tierTag(c.tier)}·${groupText(c.group)}${state})${needWx}${ro}${confirm} ${c.oneLine};适用:${c.when}`
    )
  }
  const groups: CapGroup[] = ['core', 'wechat', 'software', 'custom', 'skill', 'mcp']
  const wanted =
    scope === 'mounted'
      ? 'mounted'
      : scope === 'software'
        ? 'software'
        : scope === 'wechat'
          ? 'wechat'
          : scope === 'external'
            ? 'external'
            : 'all'
  for (const g of groups) {
    const caps = listCaps().filter((c) => c.group === g && !c.disabled)
    if (caps.length === 0) continue
    let seg: CapInfo[]
    if (wanted === 'mounted') seg = caps.filter((c) => c.tier === 0 || mounted.has(c.name))
    else if (wanted === 'software')
      seg = caps.filter((c) => c.tier >= 2 && (c.group === 'software' || c.group === 'custom'))
    else if (wanted === 'wechat') seg = caps.filter((c) => c.group === 'wechat')
    else if (wanted === 'external')
      seg = caps.filter((c) => c.group === 'skill' || c.group === 'mcp')
    else seg = caps
    if (seg.length === 0) continue
    rows.push(`【${groupText(g)}】`)
    for (const c of seg) pushRow(c)
  }
  let text = rows.join('\n')
  if (text.length > 3500) text = `${text.slice(0, 3500)}\n…(目录过长已截断,可按 scope 细分)`
  return text || '(暂无可用能力)'
}

/** 能力名(单工具能力)解析为 ToolDef;组/知识能力返回 undefined */
export function resolveCapDef(name: string): ToolDef | undefined {
  return findTool(name) ?? findSoftwareTool(name) ?? findCustomTool(name) ?? findPackTool(name)
}

/** 展开挂载集合 → 可见工具 defs + 知识文本段(组能力在此握手,失败项跳过并回报) */
export async function expandMounted(
  names: string[],
  opts: { bound: boolean }
): Promise<{ defs: ToolDef[]; knowledge: string[]; errors: string[] }> {
  const defs: ToolDef[] = []
  const knowledge: string[] = []
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
    if (cap.kind === 'knowledge') {
      const pkgName = cap.name.slice('knowledge:'.length)
      const hit = listEnabledSkills().find((s) => (s.manifest.name || s.name) === pkgName)
      if (hit?.manifest.knowledge?.trim()) {
        const k = hit.manifest.knowledge.trim()
        knowledge.push(k.length > 400 ? `${k.slice(0, 400)}…` : k)
      } else {
        errors.push(`${name}:知识不存在或已停用`)
      }
      continue
    }
    if (cap.kind === 'group') {
      // MCP 组能力:挂载即握手展开其工具(工具名 mcp_{id}_{name})
      const groupDefs = await defsOfServerCap(name)
      if (groupDefs.length === 0) errors.push(`${name}:服务器不可用或无工具`)
      else defs.push(...groupDefs)
      continue
    }
    const def = resolveCapDef(name)
    if (def) defs.push(def)
    else errors.push(`${name}:当前不可解析`)
  }
  return { defs, knowledge, errors }
}
