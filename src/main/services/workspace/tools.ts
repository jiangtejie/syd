import { execFile } from 'node:child_process'
import { promises as fs, existsSync, statSync, readdirSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

/**
 * 工作区 Agent 的受限工具集(本地自动化副驾 v1;Claude Code 风格)。
 * 安全模型:
 *  - 一切路径必须解析在工作区根(cwd)内,越界直接拒绝;
 *  - 只读工具(读文件/列目录/glob/grep)常驻可直用;
 *  - 写文件/编辑/执行命令 = 每次人工确认(引擎确认闸门),执行受限在工作区内;
 *  - 隐藏目录(node_modules/.git/dist/out/release/.cache 等)默认跳过;
 *  - 大文件/二进制防护,输出统一截断。
 */

export const WORKSPACE_TOOL_MAX_READ = 2 * 1024 * 1024
const GREP_MAX_HITS = 80
const TREE_MAX_ITEMS = 160

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'release',
  '.cache',
  '.next',
  'target',
  'build',
  '.venv',
  '__pycache__'
])
const TEXT_EXT = new Set([
  'md',
  'txt',
  'ts',
  'tsx',
  'js',
  'jsx',
  'json',
  'yaml',
  'yml',
  'toml',
  'css',
  'scss',
  'html',
  'vue',
  'py',
  'java',
  'go',
  'rs',
  'c',
  'cpp',
  'h',
  'sql',
  'sh',
  'bat',
  'ps1',
  'ini',
  'env',
  'xml',
  'csv',
  'log'
])

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n…(输出过长已截断)` : s
}

export function isLikelyBinary(buf: Buffer): boolean {
  return buf.subarray(0, 4096).includes(0)
}

/** 把用户给的路径解析到工作区内;越界抛错 */
export function resolveIn(cwd: string, p: string): string {
  const target = resolve(cwd, String(p || '.'))
  const rel = relative(cwd, target)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`路径越界:${p}(仅允许工作区内:${cwd})`)
  }
  return target
}

function desc(p: string): string {
  return p.split(/[\\/]/).slice(-2).join('/')
}

/** 单层目录列表(只读) */
export async function toolListDir(cwd: string, args: Record<string, unknown>): Promise<string> {
  const dir = resolveIn(cwd, String(args.path ?? '.'))
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (e) {
    return `无法读取目录 ${desc(dir)}:${e instanceof Error ? e.message : String(e)}`
  }
  const rows: string[] = []
  for (const en of entries.sort((a, b) =>
    a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1
  )) {
    if (en.isDirectory() && SKIP_DIRS.has(en.name)) continue
    let size = ''
    if (en.isFile()) {
      try {
        size = `${statSync(join(dir, en.name)).size} B`
      } catch {
        size = ''
      }
    }
    rows.push(`${en.isDirectory() ? '[D]' : '   '} ${en.name}${size ? `  (${size})` : ''}`)
  }
  if (rows.length === 0) return '(空目录)'
  return `目录 ${desc(dir)} 共 ${rows.length} 项:\n${clip(rows.join('\n'), 4000)}`
}

/** 读取文本文件指定行区间(只读) */
export async function toolReadFile(cwd: string, args: Record<string, unknown>): Promise<string> {
  const p = resolveIn(cwd, String(args.path ?? ''))
  let st
  try {
    st = await fs.stat(p)
  } catch (e) {
    return `文件不存在或不可读:${desc(p)}(${e instanceof Error ? e.message : String(e)})`
  }
  if (!st.isFile()) return `${desc(p)} 不是文件`
  if (st.size > WORKSPACE_TOOL_MAX_READ)
    return `文件过大(${(st.size / 1024 / 1024).toFixed(1)}MB,上限 2MB),请用 grep 定位后小范围查看`
  let buf: Buffer
  try {
    buf = await fs.readFile(p)
  } catch (e) {
    return `读取失败:${e instanceof Error ? e.message : String(e)}`
  }
  if (isLikelyBinary(buf)) return `${desc(p)} 是二进制文件,不支持文本读取`
  const text = buf.toString('utf8')
  const offset = Math.max(1, Math.floor(Number(args.offset) || 1))
  const limit = Math.min(Math.max(Math.floor(Number(args.limit) || 300), 1), 2000)
  const lines = text.split('\n')
  const slice = lines.slice(offset - 1, offset - 1 + limit)
  return clip(
    `文件 ${desc(p)} 共 ${lines.length} 行(显示 ${offset}~${offset + slice.length - 1}):\n${slice.join('\n')}`,
    6000
  )
}

/** glob(只读;轻量递归实现,不引入额外依赖) */
export async function toolGlob(cwd: string, args: Record<string, unknown>): Promise<string> {
  const pattern = String(args.pattern ?? '').trim()
  if (!pattern) return '缺少 pattern(如 **/*.ts)'
  const hits: string[] = []
  const walk = async (dir: string, rel: string): Promise<void> => {
    if (hits.length >= 300) return
    let ents
    try {
      ents = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const en of ents) {
      if (hits.length >= 300) return
      const r = rel ? `${rel}/${en.name}` : en.name
      if (en.isDirectory()) {
        if (!SKIP_DIRS.has(en.name)) await walk(join(dir, en.name), r)
      } else if (en.isFile() && matchGlob(pattern, r)) {
        hits.push(r)
      }
    }
  }
  await walk(cwd, '')
  if (hits.length === 0) return `没有匹配 ${pattern} 的文件`
  return `匹配 ${hits.length} 个文件:\n${clip(hits.join('\n'), 4000)}`
}

function matchGlob(pattern: string, p: string): boolean {
  const esc = (s: string): string => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(
    '^' +
      pattern
        .split('/')
        .map((seg) => {
          if (seg === '**') return '.*'
          if (seg.includes('**')) {
            return seg
              .split('**')
              .map((s) => esc(s))
              .join('.*')
          }
          return seg
            .split('*')
            .map((s) => esc(s))
            .join('[^/]*')
        })
        .join('/') +
      '$'
  )
  try {
    return re.test(p)
  } catch {
    return false
  }
}

/** grep(只读;跳过大文件/二进制/隐藏目录) */
export async function toolGrep(cwd: string, args: Record<string, unknown>): Promise<string> {
  const needle = String(args.pattern ?? '').trim()
  if (!needle) return '缺少 pattern(正则)'
  const include = String(args.include ?? '').trim()
  const hits: string[] = []
  const re = new RegExp(needle, 'i')
  const walk = async (dir: string): Promise<void> => {
    if (hits.length >= GREP_MAX_HITS) return
    let ents
    try {
      ents = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const en of ents) {
      if (hits.length >= GREP_MAX_HITS) return
      const full = join(dir, en.name)
      if (en.isDirectory()) {
        if (!SKIP_DIRS.has(en.name)) await walk(full)
        continue
      }
      if (!en.isFile()) continue
      const ext = basename(en.name).split('.').pop() ?? ''
      if (
        include &&
        !include
          .split(',')
          .some(
            (g) =>
              g.trim().toLowerCase() === ext.toLowerCase() || globMatchName(include.trim(), en.name)
          )
      )
        continue
      let st
      try {
        st = await fs.stat(full)
      } catch {
        continue
      }
      if (st.size > 5 * 1024 * 1024) continue
      let buf: Buffer
      try {
        buf = await fs.readFile(full)
      } catch {
        continue
      }
      if (isLikelyBinary(buf)) continue
      const lines = buf.toString('utf8').split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          const line = lines[i].length > 300 ? `${lines[i].slice(0, 300)}…` : lines[i]
          hits.push(`${relative(cwd, full)}:${i + 1}: ${line}`)
          if (hits.length >= GREP_MAX_HITS) break
        }
      }
    }
  }
  await walk(cwd)
  if (hits.length === 0) return `没有匹配「${needle}」的内容`
  return `命中 ${hits.length} 处:\n${hits.join('\n')}`
}

function globMatchName(g: string, name: string): boolean {
  const rx = new RegExp(
    '^' +
      g
        .split('*')
        .map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
        .join('.*') +
      '$',
    'i'
  )
  return rx.test(name)
}

/** 覆盖写入(需人工确认;引擎负责闸门) */
export async function toolWriteFile(cwd: string, args: Record<string, unknown>): Promise<string> {
  const p = resolveIn(cwd, String(args.path ?? ''))
  const content = String(args.content ?? '')
  if (content.length > 4 * 1024 * 1024) return '内容过大(上限 4MB)'
  await fs.mkdir(dirname(p), { recursive: true })
  await fs.writeFile(p, content, 'utf8')
  return `已写入 ${relative(cwd, p)}(${content.length} 字)`
}

/** 文本替换(需人工确认) */
export async function toolEditFile(cwd: string, args: Record<string, unknown>): Promise<string> {
  const p = resolveIn(cwd, String(args.path ?? ''))
  const oldText = String(args.old_text ?? '')
  const newText = String(args.new_text ?? '')
  if (!oldText) return '缺少 old_text(要替换的原文)'
  let buf
  try {
    buf = await fs.readFile(p)
  } catch (e) {
    return `读取失败:${e instanceof Error ? e.message : String(e)}`
  }
  if (isLikelyBinary(buf)) return `${desc(p)} 是二进制文件,不支持文本编辑`
  const text = buf.toString('utf8')
  const replaceAll = args.replace_all === true
  if (!text.includes(oldText)) return '未找到要替换的原文(注意大小写与换行)'
  const next = replaceAll ? text.split(oldText).join(newText) : text.replace(oldText, newText)
  await fs.writeFile(p, next, 'utf8')
  const times = replaceAll ? (text.match(new RegExp(escapeReg(oldText), 'g')) ?? []).length : 1
  return `已更新 ${relative(cwd, p)}(替换 ${times} 处;写前版本可从会话历史工具参数找回)`
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 执行命令(需人工确认;cwd=工作区;超时默认 120s) */
export function toolRunCommand(cwd: string, args: Record<string, unknown>): Promise<string> {
  const command = String(args.command ?? '').trim()
  if (!command) return Promise.resolve('缺少 command')
  const timeoutSec = Math.min(Math.max(Math.floor(Number(args.timeout_sec) || 120), 5), 600)
  return new Promise((resolvePromise) => {
    const child = execFile(
      process.env.ComSpec || 'cmd.exe',
      ['/d', '/s', '/c', command],
      {
        cwd,
        timeout: timeoutSec * 1000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8'
      },
      (err, stdout, stderr) => {
        const out = stdout || stderr
        const code =
          err && typeof (err as { code?: unknown }).code === 'number'
            ? (err as { code: number }).code
            : err
              ? 1
              : 0
        const tail = `${code === 0 ? '' : `(退出码 ${code})`}${out ? `\n${out}` : ''}`.trim()
        resolvePromise(tail ? clip(tail, 6000) : '(无输出)')
      }
    )
    child.on('error', (e) => resolvePromise(`命令启动失败:${e.message}`))
  })
}

/** 两层目录树(供项目上下文) */
export function buildTree(cwd: string): string {
  const lines: string[] = []
  const walk = (dir: string, depth: number, prefix: string): void => {
    if (lines.length >= TREE_MAX_ITEMS) return
    let names: string[]
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter((d) => !(d.isDirectory() && SKIP_DIRS.has(d.name)))
        .map((d) => d.name)
        .sort()
    } catch {
      return
    }
    for (const name of names) {
      if (lines.length >= TREE_MAX_ITEMS) return
      lines.push(`${prefix}${name}`)
      const full = join(dir, name)
      let isDir = false
      try {
        isDir = statSync(full).isDirectory()
      } catch {
        isDir = false
      }
      if (isDir && depth < 2) walk(full, depth + 1, `${prefix}  `)
    }
  }
  walk(cwd, 0, '')
  return clip(lines.join('\n'), 2500)
}

/** 项目上下文:CLAUDE.md/AGENTS.md/README.md + 目录树(只读自动注入) */
export async function loadProjectContext(cwd: string): Promise<string> {
  const parts: string[] = []
  const pick = async (name: string, max: number): Promise<void> => {
    const p = join(cwd, name)
    if (!existsSync(p)) return
    try {
      const st = statSync(p)
      if (!st.isFile() || st.size > 512 * 1024) return
      const txt = (await fs.readFile(p, 'utf8')).slice(0, max)
      if (txt.trim()) parts.push(`【${name}】\n${txt}`)
    } catch {
      /* ignore */
    }
  }
  await pick('CLAUDE.md', 2400)
  await pick('AGENTS.md', 2400)
  await pick('README.md', 1500)
  parts.push(`【目录结构(前两层)】\n${buildTree(cwd)}`)
  return parts.join('\n\n')
}

/** 只读工具与写工具的声明文本(注入 system;写工具注明需人工确认) */
export const WORKSPACE_TOOLS_TEXT = `可用工具(JSON 调用;写/执行类每次需人工确认,60 秒未确认视为拒绝):
- read_file(path, offset?, limit?):读文本文件的行区间(默认从第 1 行读 300 行)
- list_dir(path?):列出目录条目(默认工作区根)
- glob(pattern):按 glob 找文件(如 **/*.ts)
- grep(pattern, include?):正则搜内容(include=扩展名或 *glob*,逗号分隔)
- write_file(path, content):覆盖写入/新建文本文件【需确认】
- edit_file(path, old_text, new_text, replace_all?):文本精确替换【需确认】
- run_command(command, timeout_sec?):在工作区根执行命令(cmd),默认超时 120s【需确认】
一切路径必须位于工作区内;只读工具可直接使用,不要为只读操作请求确认。`

export { TEXT_EXT }
