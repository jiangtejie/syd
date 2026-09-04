import { listEnabledSkills } from '../../../db/repos/skillsRepo'
import type { CustomToolItem, SkillManifest } from '../../../../shared/types'
import { fetchTool } from './customTools'
import type { ToolCtx, ToolDef, ToolParamDecl } from './skills'

/**
 * 声明式第三方技能包 → 引擎注册(一期安全模型:无任意代码)。
 * - tool 类:executor=http(复用自定义工具执行器,含参数校验/超时),第三方默认每次人工确认;
 * - knowledge 类:受控文本注入 system(长度/数量受限),不注册工具;
 * - 变更即生效(每次读库,无缓存)。
 */

const KNOWLEDGE_PER_ITEM = 400
const KNOWLEDGE_TOTAL = 1500

function httpDef(name: string, manifest: SkillManifest): ToolDef {
  const t = manifest.tool!
  const params: Record<string, ToolParamDecl> = {}
  for (const p of t.params ?? []) {
    params[p.name] = {
      type: p.type,
      required: p.required,
      desc: p.desc
    }
  }
  const urlHint = t.url.length > 60 ? `${t.url.slice(0, 57)}…` : t.url
  const item: CustomToolItem = {
    id: 0,
    name,
    label: manifest.description.slice(0, 60),
    description: manifest.description,
    method: t.method ?? 'GET',
    url: t.url,
    headers: t.headers,
    params: t.params ?? [],
    timeoutSec: 20,
    confirm: true,
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  return {
    name,
    kind: 'skill',
    description: `第三方技能「${manifest.name}」v${manifest.version}:${manifest.description}(${t.method ?? 'GET'} ${urlHint})。`,
    params: Object.keys(params).length > 0 ? params : undefined,
    confirm: true, // 第三方默认每次人工确认
    run: async (_ctx: ToolCtx, args: Record<string, unknown>) => fetchTool(item, args ?? {})
  }
}

/** 已启用的 tool 类技能 → ToolDef */
export function listPackToolDefs(): ToolDef[] {
  const out: ToolDef[] = []
  for (const { manifest } of listEnabledSkills()) {
    if (manifest.kind !== 'tool' || !manifest.tool?.url) continue
    out.push(httpDef(manifest.name, manifest))
  }
  return out
}

export function findPackTool(name: string): ToolDef | undefined {
  return listPackToolDefs().find((d) => d.name === name)
}

export function packToolNames(): string[] {
  return listPackToolDefs().map((d) => d.name)
}

/** 技能工具说明(并入 system 工具段) */
export function packToolInstructionText(): string {
  const defs = listPackToolDefs()
  if (defs.length === 0) return ''
  return '已安装第三方技能工具:\n' + defs.map((d) => `- ${d.name}:${d.description}`).join('\n')
}

/** 已启用的 knowledge 类技能文本(受控注入;总量与条数受限) */
export function packKnowledgeText(): string {
  const parts: string[] = []
  let total = 0
  for (const { manifest } of listEnabledSkills()) {
    if (manifest.kind !== 'knowledge' || !manifest.knowledge?.trim()) continue
    const piece = manifest.knowledge.trim()
    const item =
      piece.length > KNOWLEDGE_PER_ITEM ? `${piece.slice(0, KNOWLEDGE_PER_ITEM)}…` : piece
    if (total + item.length > KNOWLEDGE_TOTAL) break
    parts.push(`- ${item}`)
    total += item.length
  }
  if (parts.length === 0) return ''
  return `已安装技能知识(仅相关内容时使用,不要向用户复述列表):\n${parts.join('\n')}`
}
