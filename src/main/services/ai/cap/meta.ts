import { listEnabledSkills } from '../../../db/repos/skillsRepo'
import { defsOfServerCap } from '../chat/mcp'
import { catalogText, listCaps, resolveCapDef, type CapInfo } from './registry'
import { mountCaps, unmountCaps, mountedNames } from './mounts'

/**
 * L0 核心元技能(mount/unmount/list)执行器。
 * - 纯只读、无确认;结果是“会话状态变更 + 该能力说明”,不进历史库(避免占预算);
 * - JSON 文本协议与原生 function-calling 通道共用本实现;
 * - 变更标记 changed:原生通道据此在下一轮刷新 schemas。
 */

export function metaToolDefs(): Array<{
  name: string
  description: string
  params: Record<string, { type?: 'string'; required?: boolean; desc?: string }>
}> {
  return [
    {
      name: 'list_capabilities',
      description:
        '查看能力目录:返回各层(核心/微信业务/软件能力/自定义/第三方技能/MCP)可挂载能力与其用途。args:{"scope":"all|mounted|software|wechat|external"}',
      params: { scope: { type: 'string', desc: 'all(默认)|mounted|software|wechat|external' } }
    },
    {
      name: 'mount_capability',
      description:
        '把某项能力挂载进当前会话(默认仅核心可用;挂载后其工具/知识才进入上下文)。需要业务数据/软件信息/外部技能时先 list_capabilities 找到名称再挂载。args:{"name":"能力名","why":"用途"}',
      params: {
        name: { type: 'string', required: true, desc: 'list_capabilities 中的能力名' },
        why: { type: 'string', desc: '为什么需要(50 字内)' }
      }
    },
    {
      name: 'unmount_capability',
      description: '从当前会话卸载某项已挂载能力,释放上下文预算。args:{"name":"能力名"}',
      params: { name: { type: 'string', required: true, desc: '要卸载的能力名' } }
    }
  ]
}

function clipText(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n…(过长已截断)` : s
}

/** 能力详情(挂载成功提示给模型) */
async function detailOf(cap: CapInfo, name: string): Promise<string> {
  const head = `能力「${name}」已就绪:${cap.oneLine};适用:${cap.when}`
  if (cap.kind === 'knowledge') {
    const pkg = name.slice('knowledge:'.length)
    const hit = listEnabledSkills().find((s) => (s.manifest.name || s.name) === pkg)
    const k = hit?.manifest.knowledge?.trim() ?? ''
    return `${head}\n知识内容(摘要):${k ? clipText(k, 300) : '(空)'}`
  }
  if (cap.kind === 'group') {
    const defs = await defsOfServerCap(name)
    const names = defs.map((d) => d.name).join('、')
    return `${head}\n挂载完成,工具可用:${names || '(无)'}`
  }
  const def = resolveCapDef(name)
  if (def) {
    return `${head}\n调用方式:${def.description}`
  }
  return head
}

/** 处理元技能调用;非元技能返回 null;changed=是否变更了挂载集 */
export async function runMetaTool(
  sessionId: number,
  bound: boolean,
  name: string,
  args: Record<string, unknown>
): Promise<{ full: string; changed: boolean } | null> {
  if (name === 'list_capabilities') {
    const scope = String(args?.scope ?? 'all').trim()
    const text = catalogText({ mounted: new Set(mountedNames(sessionId, bound)), bound, scope })
    return { full: text, changed: false }
  }
  if (name === 'mount_capability') {
    const capName = String(args?.name ?? '').trim()
    if (!capName)
      return { full: '缺少参数 name:要挂载的能力名(可先 list_capabilities)。', changed: false }
    const { added, errors } = mountCaps(sessionId, [capName], { bound })
    const lines: string[] = []
    for (const a of added) {
      const cap = listCaps().find((c) => c.name === a)
      if (cap) lines.push(await detailOf(cap, a))
    }
    if (errors.length > 0) lines.push(...errors.map((e) => `- ${e}`))
    if (added.length > 0) {
      lines.push('(已挂载,直接调用对应工具即可;不再需要时可调用 unmount_capability)')
    }
    return { full: clipText(lines.join('\n'), 3500), changed: added.length > 0 }
  }
  if (name === 'unmount_capability') {
    const capName = String(args?.name ?? '').trim()
    if (!capName) return { full: '缺少参数 name:要卸载的能力名。', changed: false }
    const { removed, errors } = unmountCaps(sessionId, [capName], { bound })
    const lines = [
      removed.length > 0 ? `已卸载:${removed.join('、')}。` : '',
      ...errors.map((e) => `- ${e}`)
    ]
    return { full: lines.filter(Boolean).join('\n') || '(无变化)', changed: removed.length > 0 }
  }
  return null
}
