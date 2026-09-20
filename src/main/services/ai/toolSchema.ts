import { z } from 'zod'
import type { ToolParamDecl } from './chat/skills'

/**
 * 工具参数声明（ToolParamDecl）→ zod schema。
 *
 * 为什么单独成文件：能力注册表的声明是**唯一真源**，而「给 AI SDK 的 zod 形态」要在多处用到
 * （工作台 tools.ts、能力展开 expandMounted 等）。此前各自声明一遍 zod，于是同一能力两套参数；
 * 现在统一走这里。
 */
export function zodFromParams(
  params: Record<string, ToolParamDecl> | undefined
): ReturnType<typeof z.object> {
  const shape: Record<string, z.ZodType> = {}
  for (const [name, p] of Object.entries(params ?? {})) {
    let base: z.ZodType
    switch (p.type) {
      case 'number':
        base = z.number()
        break
      case 'boolean':
        base = z.boolean()
        break
      case 'enum':
        base = p.enum && p.enum.length > 0 ? z.enum(p.enum as [string, ...string[]]) : z.string()
        break
      case 'number_array':
        base = z.array(z.number())
        break
      case 'string_array':
        base = z.array(z.string())
        break
      default:
        base = z.string()
    }
    if (p.desc) base = base.describe(p.desc)
    if (!p.required) base = base.optional()
    shape[name] = base
  }
  return z.object(shape)
}
