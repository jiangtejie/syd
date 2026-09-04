import { spawn, type ChildProcess } from 'node:child_process'
import { listMcpServers } from '../../../db/repos/mcpRepo'
import type { McpServerItem } from '../../../../shared/types'
import type { ToolCtx, ToolDef } from './skills'

/**
 * 零依赖 MCP 客户端(docs/ai-assistant-design.md §8;不引入官方 SDK)。
 * - stdio:spawn 子进程,JSON-RPC 2.0 换行分隔(initialize → tools/list → tools/call);
 * - http:fetch POST JSON-RPC(无会话态);initialize 失败容忍,直接 tools/list;
 * - 生命周期:首次调用时惰性启动,空闲 5 分钟回收;配置变更后 flushCache 重置;
 * - 工具名: mcp_{serverId}_{工具名}(模型可见名,可含字母数字下划线)。
 * 所有 MCP 工具默认 require_confirm(服务器配置可关),走引擎确认通道。
 */

interface PendingReq {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

interface McpHandle {
  server: McpServerItem
  proc: ChildProcess | null
  nextId: number
  pending: Map<number, PendingReq>
  toolList: Array<{ name: string; description: string }>
  ready: boolean
  lastUsed: number
  gcTimer: NodeJS.Timeout | null
}

const handles = new Map<number, McpHandle>()
const registeredDefs = new Map<string, ToolDef>()

const IDLE_MS = 5 * 60_000

function safeName(s: string): string {
  return (s || 'srv').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40)
}

function clip(text: string): string {
  const MAX = 4000
  return text.length > MAX ? `${text.slice(0, MAX)}\n…(已截断)` : text
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时(${ms / 1000}s)`)), ms)
  })
  try {
    return await Promise.race([p, t])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function stdioRequest(
  h: McpHandle,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number
): Promise<unknown> {
  const proc = h.proc
  if (!proc || proc.exitCode !== null) throw new Error('MCP 子进程未运行')
  const id = ++h.nextId
  return await new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      h.pending.delete(id)
      reject(new Error(`${method} 超时`))
      killHandle(h, '请求超时')
    }, timeoutMs)
    h.pending.set(id, { resolve, reject, timer })
    proc.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

function killHandle(h: McpHandle, reason: string): void {
  if (h.gcTimer) clearTimeout(h.gcTimer)
  h.gcTimer = null
  for (const [, p] of h.pending) {
    clearTimeout(p.timer)
    p.reject(new Error(`MCP 连接已关闭:${reason}`))
  }
  h.pending.clear()
  h.toolList = []
  h.ready = false
  h.proc?.kill()
  h.proc = null
}

async function initStdio(h: McpHandle): Promise<void> {
  if (h.proc && h.proc.exitCode === null) return
  const s = h.server
  const proc = spawn(s.command ?? '', s.args ?? [], {
    stdio: ['pipe', 'pipe', 'pipe']
  })
  h.proc = proc
  h.nextId = 0
  let buf = ''
  const onData = (chunk: Buffer): void => {
    buf += chunk.toString()
    for (;;) {
      const nl = buf.indexOf('\n')
      if (nl < 0) break
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      let msg: { id?: number; error?: { message?: string }; result?: unknown }
      try {
        msg = JSON.parse(line) as typeof msg
      } catch {
        continue
      }
      if (typeof msg.id === 'number' && h.pending.has(msg.id)) {
        const p = h.pending.get(msg.id)!
        h.pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.error) p.reject(new Error(msg.error.message || 'MCP 请求错误'))
        else p.resolve(msg.result)
      }
    }
  }
  proc.stdout?.on('data', onData)
  proc.stderr?.on('data', (c) => {
    /* 服务器日志仅调试用 */
    const s2 = c.toString().trim()
    if (s2) console.log(`[mcp:${h.server.name}]`, s2.slice(0, 300))
  })
  proc.on('exit', (code) => {
    if (h.proc === proc) killHandle(h, `进程退出 code=${code}`)
  })
  await withTimeout(
    stdioRequest(
      h,
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'wechat-cs-desktop', version: '1.0.0' }
      },
      Math.min(h.server.timeoutSec * 1000, 15_000)
    ),
    Math.min(h.server.timeoutSec * 1000, 15_000),
    'MCP 握手'
  )
  proc.stdin?.write(
    `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`
  )
  h.ready = true
}

async function httpRequest(
  s: McpServerItem,
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), s.timeoutSec * 1000)
  try {
    const res = await fetch(s.url ?? '', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctrl.signal
    })
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}`)
    const data = (await res.json()) as { error?: { message?: string }; result?: unknown }
    if (data.error) throw new Error(data.error.message || 'MCP 请求错误')
    return data.result
  } finally {
    clearTimeout(timer)
  }
}

async function refreshTools(h: McpHandle): Promise<void> {
  const s = h.server
  const listRes = h.ready
    ? await stdioRequest(h, 'tools/list', {}, s.timeoutSec * 1000)
    : await httpRequest(s, 'tools/list', {})
  const list = (listRes as { tools?: Array<{ name?: string; description?: string }> })?.tools ?? []
  h.toolList = list
    .filter((t) => typeof t?.name === 'string' && t.name)
    .map((t) => ({ name: t.name as string, description: (t.description || '').slice(0, 300) }))
}

async function ensureReady(serverId: number): Promise<McpHandle> {
  let h = handles.get(serverId)
  if (!h) {
    const server = listMcpServers().find((x) => x.id === serverId)
    if (!server || !server.enabled) throw new Error('MCP 服务器不存在或未启用')
    h = {
      server,
      proc: null,
      nextId: 0,
      pending: new Map(),
      toolList: [],
      ready: false,
      lastUsed: Date.now(),
      gcTimer: null
    }
    handles.set(serverId, h)
  }
  h.lastUsed = Date.now()
  // 空闲回收(stdio 进程):闲置 IDLE_MS 后杀掉,下次调用自动重建
  if (h.gcTimer) clearTimeout(h.gcTimer)
  h.gcTimer = setTimeout(() => {
    const cur = handles.get(serverId)
    if (cur && Date.now() - cur.lastUsed >= IDLE_MS) {
      killHandle(cur, '空闲回收')
    }
  }, IDLE_MS)
  h.gcTimer.unref?.()
  if (h.server.kind === 'stdio' && !h.ready) {
    await initStdio(h)
    await refreshTools(h)
  }
  if (h.server.kind === 'http') {
    // http 无状态:每轮直连,initialize 非必需;直接拉取工具
    await refreshTools(h)
  }
  return h
}

/** 启动所有启用服务器并生成工具说明(失败项跳过并在文本中注明) */
export async function ensureAllServers(): Promise<void> {
  const servers = listMcpServers().filter((s) => s.enabled)
  if (servers.length === 0) return
  await Promise.all(
    servers.map(async (s) => {
      try {
        await ensureReady(s.id)
      } catch (e) {
        console.log(`[mcp] 服务器「${s.name}」不可用:`, e instanceof Error ? e.message : e)
      }
    })
  )
}

/** 已就绪服务器的工具说明文本(拼入 system;无需等待全部失败) */
export async function mcpToolInstructionText(): Promise<string> {
  const lines: string[] = []
  for (const s of listMcpServers().filter((x) => x.enabled)) {
    try {
      const defs = await serverToolDefs(s.id)
      for (const d of defs) lines.push(`- ${d.name}:${d.description}`)
    } catch {
      /* 单个服务器失败不阻塞 */
    }
  }
  return lines.length > 0 ? `MCP 外部工具(执行前通常需要人工确认):\n${lines.join('\n')}` : ''
}

/** 挂载粒度:MCP 服务器组能力(mcp@服务器名)→ 懒加载其全部工具 def(注册进全局表) */
export async function defsOfServerCap(capName: string): Promise<ToolDef[]> {
  const srvName = capName.startsWith('mcp@') ? capName.slice('mcp@'.length) : ''
  const server = listMcpServers().find((x) => x.enabled && x.name === srvName)
  if (!server) return []
  try {
    return await serverToolDefs(server.id)
  } catch {
    return []
  }
}

/** 组能力注册到全局表的核心实现:ensure 就绪后为该服务器每个工具注册 def */
async function serverToolDefs(serverId: number): Promise<ToolDef[]> {
  await ensureReady(serverId)
  const h = handles.get(serverId)
  if (!h) return []
  const out: ToolDef[] = []
  for (const t of h.toolList) {
    const name = `mcp_${h.server.id}_${safeName(t.name)}`
    let def = registeredDefs.get(name)
    if (!def) {
      def = {
        name,
        kind: 'mcp',
        description: `(MCP 服务器:${h.server.name}) ${t.description || '外部工具'} args 按该工具 schema 提供`,
        confirm: h.server.confirm,
        run: async (_ctx: ToolCtx, args: Record<string, unknown>) => {
          const handle = await ensureReady(h.server.id)
          try {
            const res = handle.ready
              ? await stdioRequest(
                  handle,
                  'tools/call',
                  { name: t.name, arguments: args },
                  handle.server.timeoutSec * 1000
                )
              : await httpRequest(handle.server, 'tools/call', { name: t.name, arguments: args })
            const r = res as {
              isError?: boolean
              content?: Array<{ type?: string; text?: string }>
              structuredContent?: unknown
            }
            if (r.isError) throw new Error('工具返回错误(见内容)')
            const text = (r.content ?? [])
              .filter((c) => c.type === 'text' && typeof c.text === 'string')
              .map((c) => c.text as string)
              .join('\n')
            const extra =
              r.structuredContent !== undefined
                ? `\n(结构化数据)\n${JSON.stringify(r.structuredContent, null, 1).slice(0, 2000)}`
                : ''
            if (!text && !extra.trim()) return '(工具无文本输出)'
            return clip(text + extra)
          } catch (e) {
            return `MCP 工具执行失败:${e instanceof Error ? e.message : String(e)}`
          }
        }
      }
      registeredDefs.set(name, def)
    }
    out.push(def)
  }
  return out
}

export function findMcpTool(name: string): ToolDef | undefined {
  return registeredDefs.get(name)
}

export function mcpToolNames(): string[] {
  return [...registeredDefs.keys()]
}

/** 配置变更/退出时清理全部连接(下次调用自动重建) */
export function flushMcpCache(): void {
  for (const h of handles.values()) killHandle(h, '配置变更')
  handles.clear()
  registeredDefs.clear()
}
