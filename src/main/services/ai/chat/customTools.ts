import { listCustomTools } from '../../../db/repos/customToolRepo'
import type { CustomToolItem } from '../../../../shared/types'
import type { ToolCtx, ToolDef, ToolParamDecl } from './skills'

/**
 * 自定义 HTTP 工具(应用内“开发工具”,docs 补丁)。
 * 用户配置 {标识/描述/方法/URL/参数声明} 即可让 AI 调用内部或外部接口:
 * - params: [{name, desc, type?, required?, in?: query|path|body}] 声明模型参数如何映射;
 * - path 参数经 {name} 占位替换;query 进 URLSearchParams;body 进 JSON 请求体;
 * - GET/HEAD 只读;写方法(POST/PUT/PATCH/DELETE)强制 confirm=true(引擎侧执行前人工确认);
 * - headers 明文存储,UI 提示勿放密钥。
 */

const MAX_BODY = 4000

function clip(s: string): string {
  return s.length > MAX_BODY ? `${s.slice(0, MAX_BODY)}\n…(已截断)` : s
}

async function fetchTool(tool: CustomToolItem, args: Record<string, unknown>): Promise<string> {
  const params = tool.params ?? []
  const headers: Record<string, string> = { ...(tool.headers ?? {}) }
  const query = new URLSearchParams()
  const bodyObj: Record<string, unknown> = {}
  let url = tool.url
  for (const p of params) {
    const v = args[p.name]
    const missing = v === undefined || v === null || v === ''
    if (missing && p.required) {
      return `缺少必填参数 ${p.name}${p.desc ? `(${p.desc})` : ''},请补全后重试。`
    }
    if (missing) continue
    // 类型校验/归一(number/boolean),错误文本回填模型让其修正
    let val: unknown = v
    if (p.type === 'number') {
      const n = typeof v === 'number' ? v : Number(v)
      if (!Number.isFinite(n)) return `参数 ${p.name} 需要数字类型。`
      val = n
    } else if (p.type === 'boolean') {
      if (typeof v === 'boolean') val = v
      else if (v === 'true' || v === 1) val = true
      else if (v === 'false' || v === 0) val = false
      else return `参数 ${p.name} 需要布尔类型(true/false)。`
    }
    const str = typeof val === 'string' ? val : JSON.stringify(val)
    if (p.in === 'path') {
      url = url.replace(`{${p.name}}`, encodeURIComponent(str))
    } else if (p.in === 'body') {
      bodyObj[p.name] = val
    } else {
      query.append(p.name, str)
    }
  }
  const isRead = tool.method === 'GET' || tool.method === 'HEAD'
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), tool.timeoutSec * 1000)
  try {
    const qs = query.toString()
    const target = isRead && qs ? `${url}${url.includes('?') ? '&' : '?'}${qs}` : url
    const res = await fetch(target, {
      method: tool.method,
      headers: { ...(isRead ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: isRead ? undefined : JSON.stringify(bodyObj),
      signal: ctrl.signal
    })
    const text = clip(await res.text())
    if (!res.ok) {
      return `HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`
    }
    if (!text) return `(空响应 HTTP ${res.status})`
    // JSON 响应美化便于模型阅读
    try {
      const j = JSON.parse(text) as unknown
      return clip(JSON.stringify(j, null, 1))
    } catch {
      return text
    }
  } catch (e) {
    const msg = ctrl.signal.aborted
      ? `请求超时(${tool.timeoutSec}s)`
      : e instanceof Error
        ? e.message
        : String(e)
    return `请求失败:${msg}`
  } finally {
    clearTimeout(timer)
  }
}

/** 读取启用中的自定义工具并转成 ToolDef(写方法 confirm=true 由引擎确认) */
export function listCustomToolDefs(): ToolDef[] {
  return listCustomTools()
    .filter((t) => t.enabled)
    .map((t) => {
      const isRead = t.method === 'GET' || t.method === 'HEAD'
      const params: Record<string, ToolParamDecl> = {}
      for (const p of t.params ?? []) {
        params[p.name] = {
          type:
            p.type === 'number' || p.type === 'boolean' || p.type === 'string' ? p.type : undefined,
          required: p.required,
          desc: p.desc
        }
      }
      const argHint =
        (t.params ?? []).length > 0
          ? ` args 形如:{"${(t.params ?? [])
              .slice(0, 6)
              .map((p) => p.name)
              .join('","')}"}(可选参数可省略)`
          : ' args:{}'
      const urlHint = t.url.length > 60 ? `${t.url.slice(0, 57)}…` : t.url
      return {
        name: t.name,
        kind: 'skill' as const,
        description: `${t.label ? `【${t.label}】` : ''}${t.description}(${t.method} ${urlHint})。${argHint}`,
        params: Object.keys(params).length > 0 ? params : undefined,
        confirm: isRead ? t.confirm : true,
        run: async (_ctx: ToolCtx, args: Record<string, unknown>) => fetchTool(t, args ?? {})
      }
    })
}

/** 自定义工具说明文本(并入 system) */
export function customToolInstructionText(): string {
  const defs = listCustomToolDefs()
  if (defs.length === 0) return ''
  return '自定义 HTTP 工具:\n' + defs.map((d) => `- ${d.name}:${d.description}`).join('\n')
}

export function findCustomTool(name: string): ToolDef | undefined {
  return listCustomToolDefs().find((t) => t.name === name)
}
