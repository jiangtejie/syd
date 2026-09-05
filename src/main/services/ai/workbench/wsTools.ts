import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import type { ToolDef } from '../chat/skills'
import { getChatWorkspace } from '../../../db/repos/chatRepo'
import { createLogger } from '../../logging'

/**
 * 工作区文件工具(WorkBuddy 式):每个工作台会话可绑定一个真实目录,
 * 智能体在目录内直接读写文本文件。
 * - 沙箱:所有路径经 jailPath 校验,必须落在工作区根内(防 ../、符号链接逃逸)
 * - 写入类工具由上层(workbench tools)挂审批后再执行
 * - 仅文本(UTF-8),读取 ≤READ_CAP、写入 ≤WRITE_CAP,防烧上下文与意外巨文件
 */

const wsLog = createLogger('ws')

const READ_CAP = 300 * 1024
const WRITE_CAP = 200 * 1024
const LIST_CAP = 600
const SKIP_DIRS = new Set(['.git', '.svn', 'node_modules', '.DS_Store'])

/** 会话 → 工作区根(未绑定返回 null) */
function rootOf(ctx: { sessionId?: string | undefined }): string | null {
  const sid = Number(ctx.sessionId)
  const dir = Number.isInteger(sid) ? getChatWorkspace(sid) : null
  return dir && existsSync(dir) ? dir : null
}

const NO_WS =
  '当前会话未绑定工作区。请先在工作台顶部「工作区」选择文件夹(或解除后重新绑定),再使用文件工具。'

/** 沙箱解析:相对路径必须落在 root 内;返回绝对路径,违规返回 null */
function jailPath(root: string, rel: string): string | null {
  const p = String(rel ?? '')
    .trim()
    .replace(/\\/g, '/')
  if (!p || isAbsolute(p)) return null
  if (p === '.') return root
  let base = root
  try {
    base = realpathSync(root)
  } catch {
    /* 根不可解析时退化为词法比较 */
  }
  const prefix = base.replace(/[\\/]+$/, '') + '/'
  const abs = resolve(root, p)
  if (abs !== root && !abs.startsWith(prefix)) return null
  // 符号链接/目录联接逃逸:对已存在的路径段做 realpath 校验(均折算到真实根比较)
  let probe = abs
  for (;;) {
    const parent = dirname(probe)
    if (parent === probe) break
    if (existsSync(probe)) {
      try {
        const real = realpathSync(probe)
        if (real !== base && !real.startsWith(prefix)) return null
      } catch {
        return null
      }
      break
    }
    probe = parent
  }
  return normalize(abs)
}

/** 文件类型小图标/类型词 */
function kindOf(name: string, isDir: boolean): string {
  if (isDir) return 'dir'
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  return ext || 'file'
}

/** 列目录(可递归,深度/条目上限,跳过常见重型目录) */
function walk(root: string, relDir: string, recursive: boolean, depth: number): string[] {
  const out: string[] = []
  const scan = (dir: string, d: number): void => {
    if (out.length >= LIST_CAP) return
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (out.length >= LIST_CAP) return
      if (recursive && name.startsWith('.') && SKIP_DIRS.has(name)) continue
      const abs = join(dir, name)
      let isDir = false
      try {
        isDir = statSync(abs).isDirectory()
      } catch {
        continue
      }
      const rel = relDir ? `${relDir}/${name}` : name
      if (isDir) {
        out.push(`${rel}/`)
        if (recursive && d < depth) scan(abs, d + 1)
      } else {
        out.push(rel)
      }
    }
  }
  scan(root, 0)
  return out
}

function defOf(name: string, p: ToolDef['params'], desc: string, run: ToolDef['run']): ToolDef {
  return { name, kind: 'builtin', params: p, description: desc, run }
}

/** 工作区工具(读写均以会话绑定目录为根) */
export const WS_TOOLS: ToolDef[] = [
  defOf(
    'workspace_list',
    {
      path: { type: 'string', desc: '相对目录(空=根)"' },
      recursive: { type: 'boolean', desc: '是否递归' }
    },
    '列出工作区内某目录的文件与子目录(相对路径;默认仅一层,可递归,自动跳过 .git/node_modules 等)。' +
      'args: {"path":"docs","recursive":true}',
    async (ctx, args) => {
      const root = rootOf(ctx)
      if (!root) return NO_WS
      const jail = jailPath(root, String(args?.path ?? '').replace(/^\/+/, '') || '.')
      if (!jail) return '路径越界:只能访问工作区目录内的内容。'
      if (!existsSync(jail) || !statSync(jail).isDirectory())
        return `目录不存在:${args?.path ?? '.'}`
      const lines = walk(
        jail,
        String(args?.path ?? '').replace(/^\/+/, ''),
        args?.recursive === true,
        6
      )
      if (lines.length === 0) return '(目录为空)'
      return lines.map((l) => `- ${l}`).join('\n')
    }
  ),
  defOf(
    'workspace_read',
    {
      path: { type: 'string', required: true, desc: '相对文件路径' },
      maxLines: { type: 'number', desc: '最多读取行数(默认 200)' }
    },
    '读取工作区内文本文件(UTF-8,上限 300KB/2000 行;图片等二进制请用 file_info 提示)。' +
      'args: {"path":"docs/方案.md","maxLines":200}',
    async (ctx, args) => {
      const root = rootOf(ctx)
      if (!root) return NO_WS
      const p = String(args?.path ?? '')
        .trim()
        .replace(/\\/g, '/')
      const jail = jailPath(root, p)
      if (!jail) return '路径越界:只能读取工作区目录内的文件。'
      try {
        if (!existsSync(jail) || !statSync(jail).isFile()) return `文件不存在:${p}`
        const st = statSync(jail)
        if (st.size > READ_CAP) return `文件过大(${st.size} 字节,上限 ${READ_CAP}),请拆分或换文件。`
        let text = readFileSync(jail, 'utf8')
        const maxLines = Math.min(Math.max(Math.floor(Number(args?.maxLines) || 200), 1), 2000)
        const lines = text.split('\n')
        const clipped = lines.length > maxLines
        text = lines.slice(0, maxLines).join('\n')
        const brief = text.trim().length > 0 ? text : '(空文件或全空白)'
        return `文件:${p}(${st.size} 字节,${lines.length} 行)\n\n${brief}${clipped ? '\n…(超出 ' + maxLines + ' 行,已截断)' : ''}`
      } catch (e) {
        return `读取失败:${e instanceof Error ? e.message : String(e)}`
      }
    }
  ),
  defOf(
    'workspace_search',
    {
      q: { type: 'string', required: true, desc: '关键词' },
      ext: { type: 'string', desc: '扩展名过滤,如 md/json(逗号分隔)' },
      path: { type: 'string', desc: '起始相对目录(空=根)' }
    },
    '在工作区文本文件中全文搜索关键词,返回 文件:行号:内容(最多 60 处;自动跳过 .git/node_modules)。' +
      'args: {"q":"发货政策","ext":"md"}',
    async (ctx, args) => {
      const root = rootOf(ctx)
      if (!root) return NO_WS
      const q = String(args?.q ?? '').trim()
      if (!q) return '缺少关键词 q。'
      const start = jailPath(root, String(args?.path ?? '').replace(/^\/+/, '') || '.')
      if (!start) return '路径越界。'
      const exts = new Set(
        String(args?.ext ?? '')
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      )
      const hits: string[] = []
      const files = walk(start, String(args?.path ?? '').replace(/^\/+/, ''), true, 6)
      for (const rel of files) {
        if (hits.length >= 60) break
        if (rel.endsWith('/')) continue
        const name = basename(rel)
        if (name.startsWith('.')) continue
        if (exts.size > 0) {
          const dot = name.lastIndexOf('.')
          if (dot <= 0 || !exts.has(name.slice(dot + 1).toLowerCase())) continue
        }
        const abs = join(root, rel)
        try {
          if (statSync(abs).size > READ_CAP) continue
          const lines = readFileSync(abs, 'utf8').split('\n')
          for (let i = 0; i < lines.length; i++) {
            if (hits.length >= 60) break
            const line = lines[i]
            if (line.length < 500 && line.includes(q)) {
              hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 160)}`)
            }
          }
        } catch {
          /* 单个文件失败跳过 */
        }
      }
      return hits.length > 0 ? hits.join('\n') : `未找到包含「${q}」的内容。`
    }
  ),
  defOf(
    'workspace_file_info',
    {
      path: { type: 'string', required: true, desc: '相对文件或目录路径' }
    },
    '查看工作区内文件/目录信息(大小/类型/修改时间;用于判断二进制或需要操作的目标)。args: {"path":"report.xlsx"}',
    async (ctx, args) => {
      const root = rootOf(ctx)
      if (!root) return NO_WS
      const jail = jailPath(
        root,
        String(args?.path ?? '')
          .trim()
          .replace(/\\/g, '/')
      )
      if (!jail) return '路径越界。'
      try {
        if (!existsSync(jail)) return `不存在:${args?.path}`
        const st = statSync(jail)
        if (st.isDirectory()) {
          const names = readdirSync(jail)
          return `目录:${args?.path ?? '.'} · ${names.length} 项(可用 workspace_list 查看)`
        }
        const t = new Date(st.mtimeMs)
        return `文件:${args?.path}\n大小:${st.size} 字节\n类型:${kindOf(basename(jail), false)}\n修改时间:${t.toISOString().slice(0, 19)}`
      } catch (e) {
        return `查询失败:${e instanceof Error ? e.message : String(e)}`
      }
    }
  ),
  defOf(
    'workspace_write',
    {
      path: { type: 'string', required: true, desc: '相对文件路径' },
      content: { type: 'string', required: true, desc: '完整内容(UTF-8,≤200KB)' },
      mode: {
        type: 'string',
        desc: 'new=仅新建(已存在则失败)/overwrite=覆盖/append=追加(默认 overwrite)'
      }
    },
    '写入/覆盖/追加工作区文本文件(写操作,执行前需人工确认;不会创建文件时自动建父目录?父目录须已存在)。' +
      'args: {"path":"docs/回复模板.md","content":"...","mode":"overwrite"}',
    async (ctx, args) => {
      const root = rootOf(ctx)
      if (!root) return NO_WS
      const p = String(args?.path ?? '')
        .trim()
        .replace(/\\/g, '/')
      const jail = jailPath(root, p)
      if (!jail) return '路径越界:只能写入工作区目录内。'
      const content = String(args?.content ?? '')
      if (content.length > WRITE_CAP) return `内容过长(${content.length} 字符,上限 ${WRITE_CAP})。`
      const mode = String(args?.mode ?? 'overwrite')
      try {
        const existed = existsSync(jail)
        if (mode === 'new' && existed) return `文件已存在:${p}(如需覆盖请用 overwrite)。`
        if (!existed && mode === 'append') {
          // 追加不存在 → 按新建处理
        }
        const parent = dirname(jail)
        if (!existsSync(parent))
          return `父目录不存在:${dirname(p)}(可先用工作区列目录确认,当前不支持自动建目录)。`
        if (mode === 'append' && existed) appendFileSync(jail, content, 'utf8')
        else writeFileSync(jail, content, 'utf8')
        wsLog.info(`工作区写入 ${p} mode=${mode} bytes=${Buffer.byteLength(content, 'utf8')}`)
        return existed
          ? mode === 'append'
            ? `已追加 ${p}(${Buffer.byteLength(content, 'utf8')} 字节)`
            : `已覆盖 ${p}`
          : `已创建 ${p}`
      } catch (e) {
        wsLog.error(`工作区写入失败 ${p}`, e)
        return `写入失败:${e instanceof Error ? e.message : String(e)}`
      }
    }
  ),
  defOf(
    'workspace_mkdir',
    {
      path: { type: 'string', required: true, desc: '相对目录路径(单层;父目录须已存在)' }
    },
    '在工作区创建一级目录(父目录必须已存在;如需嵌套请逐级创建)。args: {"path":"drafts"}',
    async (ctx, args) => {
      const root = rootOf(ctx)
      if (!root) return NO_WS
      const jail = jailPath(
        root,
        String(args?.path ?? '')
          .trim()
          .replace(/\\/g, '/')
      )
      if (!jail) return '路径越界。'
      if (existsSync(jail)) return `目录已存在:${args?.path}`
      try {
        mkdirSync(jail)
        wsLog.info(`工作区建目录 ${args?.path}`)
        return `已创建目录 ${args?.path}`
      } catch (e) {
        return `创建失败:${e instanceof Error ? e.message : String(e)}(请确认父目录存在且为单层目录)`
      }
    }
  ),
  defOf(
    'workspace_delete',
    {
      path: { type: 'string', required: true, desc: '相对文件路径(仅文件,不删目录)' }
    },
    '删除工作区内一个文件(危险操作,执行前需人工确认;不支持删除目录)。args: {"path":"drafts/草稿.md"}',
    async (ctx, args) => {
      const root = rootOf(ctx)
      if (!root) return NO_WS
      const jail = jailPath(
        root,
        String(args?.path ?? '')
          .trim()
          .replace(/\\/g, '/')
      )
      if (!jail) return '路径越界。'
      try {
        if (!existsSync(jail) || !statSync(jail).isFile())
          return `文件不存在或不是文件:${args?.path}`
        rmSync(jail, { force: true })
        wsLog.warn(`工作区删除文件 ${args?.path}`)
        return `已删除 ${args?.path}`
      } catch (e) {
        return `删除失败:${e instanceof Error ? e.message : String(e)}`
      }
    }
  )
]

export function findWsTool(name: string): ToolDef | undefined {
  return WS_TOOLS.find((t) => t.name === name)
}

/** 写/危险类工具:需要逐次审批 */
const WRITE_NAMES = new Set(['workspace_write', 'workspace_mkdir', 'workspace_delete'])
export const WS_READONLY_NAMES = WS_TOOLS.map((t) => t.name).filter((n) => !WRITE_NAMES.has(n))
export const WS_WRITE_NAMES = [...WRITE_NAMES]

export function isWsWriteTool(name: string): boolean {
  return WRITE_NAMES.has(name)
}
