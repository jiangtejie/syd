import { getDb } from '../database'
import type { AiAgent, AiAgentInput, AiStyle } from '../../../shared/types'
import { getConfig, setConfig } from './config'
import { APP_NAME } from '../../../shared/appInfo'

/**
 * ai_agent（智能体/客服人设）持久化。
 * - 至少保留一个智能体；首次使用自动播种内置默认「私域运营助手」（老库里的旧名由迁移 6 改掉）；
 * - 默认智能体 id 存 app_config（key: agent.defaultId）。
 */

const DEFAULT_AGENT_ID_KEY = 'agent.defaultId'

const VALID_STYLES: AiStyle[] = ['formal', 'warm', 'brief']

interface AgentRow {
  id: string
  name: string
  description: string
  style: string
  prompt: string
  created_at: number
  updated_at: number
}

function rowToAgent(r: AgentRow): AiAgent {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    style: (VALID_STYLES.includes(r.style as AiStyle) ? r.style : 'warm') as AiStyle,
    prompt: r.prompt,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

function seedBuiltinIfEmpty(): void {
  const db = getDb()
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ai_agent`).get() as { n: number }
  if (row.n > 0) return
  const now = Date.now()
  const id = 'builtin-default'
  db.prepare(
    `INSERT INTO ai_agent (id, name, description, style, prompt, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    APP_NAME,
    '你是一位专业、耐心的企业私域客服，熟悉产品与活动，能站在客户角度给出准确回复。',
    'warm',
    '',
    now,
    now
  )
}

/** 全部智能体（含播种）；并确保默认智能体配置有效 */
export function listAgents(): AiAgent[] {
  seedBuiltinIfEmpty()
  const db = getDb()
  const rows = db
    .prepare(`SELECT * FROM ai_agent ORDER BY created_at ASC, id ASC`)
    .all() as AgentRow[]
  const agents = rows.map(rowToAgent)
  const defaultId = getConfig(DEFAULT_AGENT_ID_KEY)
  if (!defaultId || !agents.some((a) => a.id === defaultId)) {
    setConfig(DEFAULT_AGENT_ID_KEY, agents[0].id)
  }
  return agents
}

/** 默认智能体（配置指向不存在时回退到第一个） */
export function getDefaultAgent(): AiAgent | undefined {
  seedBuiltinIfEmpty()
  const agents = listAgents()
  const defaultId = getConfig(DEFAULT_AGENT_ID_KEY)
  return agents.find((a) => a.id === defaultId) ?? agents[0]
}

export function getAgentById(id: string | undefined | null): AiAgent | undefined {
  if (!id) return undefined
  seedBuiltinIfEmpty()
  const row = getDb().prepare(`SELECT * FROM ai_agent WHERE id = ?`).get(id) as AgentRow | undefined
  return row ? rowToAgent(row) : undefined
}

/** 校验输入并保存（新建或更新）；返回完整智能体 */
export function saveAgent(input: AiAgentInput): AiAgent {
  const name = input.name?.trim()
  if (!name) throw new Error('智能体名称不能为空')
  const style: AiStyle = VALID_STYLES.includes(input.style) ? input.style : 'warm'
  const description = input.description?.trim() ?? ''
  const prompt = input.prompt?.trim() ?? ''
  const db = getDb()
  const now = Date.now()
  const existing = input.id ? getAgentById(input.id) : undefined
  if (existing) {
    db.prepare(
      `UPDATE ai_agent SET name = ?, description = ?, style = ?, prompt = ?, updated_at = ?
       WHERE id = ?`
    ).run(name, description, style, prompt, now, existing.id)
    return { ...existing, name, description, style, prompt, updatedAt: now }
  }
  const id = input.id?.trim() || `ag-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  db.prepare(
    `INSERT INTO ai_agent (id, name, description, style, prompt, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, name, description, style, prompt, now, now)
  const created: AiAgent = {
    id,
    name,
    description,
    style,
    prompt,
    createdAt: now,
    updatedAt: now
  }
  // 首次新建（播种后首个自定义）时不改动默认；若无任何有效默认则设为首个
  if (!getConfig(DEFAULT_AGENT_ID_KEY)) setConfig(DEFAULT_AGENT_ID_KEY, id)
  return created
}
