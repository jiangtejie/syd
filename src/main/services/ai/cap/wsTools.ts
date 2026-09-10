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
import { getConfig } from '../../../db/repos/config'
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

/**
 * 会话 → 工作区根:
 *   ① 会话绑定目录(工作台顶部「工作区」)→ 优先;
 *   ② 未绑定时回退到全局默认工作区(config `wb.defaultWorkspace`,设置 → AI 助手),
 *      使飞书/IM 渠道这类没有工作台界面的会话也能读写文件;
 *   ③ 都没有则返回 null(工具返回可行动提示)。
 */
function rootOf(ctx: { sessionId?: string | undefined }): string | null {
  const sid = Number(ctx.sessionId)
  const bound = Number.isInteger(sid) ? getChatWorkspace(sid) : null
  if (bound && existsSync(bound)) return bound
  const fallback = (getConfig('wb.defaultWorkspace') ?? '').trim()
  return fallback && existsSync(fallback) ? fallback : null
}

const NO_WS =
  '当前会话没有可用工作区。请在「设置 → AI 助手 → 默认工作区」指定一个目录(飞书/IM 渠道用),' +
  '或在工作台顶部「工作区」为该会话绑定文件夹后重试。'

/** 前缀包含判断(兼容 Windows 反斜杠与正斜杠,忽略大小写) */
function withinBase(base: string, target: string): boolean {
  const b = base.replace(/[\\/]+$/, '').toLowerCase()
  const t = target.toLowerCase()
  return t === b || t.startsWith(`${b}\\`) || t.startsWith(`${b}/`)
}

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
  const abs = resolve(root, p)
  if (!withinBase(base, abs)) return null
  // 符号链接/目录联接逃逸:对已存在的路径段做 realpath 校验(均折算到真实根比较)
  let probe = abs
  for (;;) {
    const parent = dirname(probe)
    if (parent === probe) break
    if (existsSync(probe)) {
      try {
        if (!withinBase(base, realpathSync(probe))) return null
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

/* ── 办公能力:CSV / xlsx / 静态站点脚手架(写类均需逐次审批) ── */

/** 简易 CSV 行解析(支持引号包裹的逗号与 "" 转义) */
function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQ = false
        }
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      inQ = true
    } else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out
}

/** CSV 预览:列头 + 抽样行(≤maxRows) */
WS_TOOLS.push(
  defOf(
    'csv_read',
    {
      path: { type: 'string', required: true, desc: '相对 CSV 文件路径' },
      maxRows: { type: 'number', desc: '预览行数(默认 100)' }
    },
    '预览工作区 CSV 文件:首行列头 + 抽样行(自动处理引号,上限 500 行)。' +
      'args: {"path":"名单.csv","maxRows":100}',
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
        if (!existsSync(jail) || !statSync(jail).isFile()) return `文件不存在:${args?.path}`
        if (statSync(jail).size > 512 * 1024)
          return 'CSV 超过 512KB,请先用 workspace_read 抽样查看。'
        const maxRows = Math.min(Math.max(Math.floor(Number(args?.maxRows) || 100), 1), 500)
        const text = readFileSync(jail, 'utf8')
        const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
        if (lines.length === 0) return '(空 CSV)'
        const head = parseCsvLine(lines[0])
        const parts = [`表头(${head.length} 列):${head.join(' | ')}`]
        const total = lines.length - 1
        for (let i = 1; i < lines.length && i <= maxRows; i++) {
          const row = parseCsvLine(lines[i])
          parts.push(`${i}: ${row.join(' | ')}`)
        }
        parts.push(`合计数据行 ${total} 行${total > maxRows ? `,仅显示前 ${maxRows} 行` : ''}`)
        return parts.join('\n')
      } catch (e) {
        return `读取失败:${e instanceof Error ? e.message : String(e)}`
      }
    }
  ),
  defOf(
    'csv_append',
    {
      path: { type: 'string', required: true, desc: '相对 CSV 文件路径' },
      rows: {
        type: 'string',
        required: true,
        desc: '要追加的行,每行一条 CSV(逗号分隔,字段含逗号用引号)'
      }
    },
    '向工作区 CSV 文件追加数据行(写操作,需审批;列数应与表头一致,自动补换行)。' +
      'args: {"path":"名单.csv","rows":"张三,待跟进,昨天\\n李四,已解决,今天"}',
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
      const rows = String(args?.rows ?? '').trim()
      if (!rows) return '缺少 rows。'
      try {
        const existed = existsSync(jail) && statSync(jail).isFile()
        const lines = rows.split(/\r?\n/).filter((l) => l.trim() !== '')
        const text = existed ? readFileSync(jail, 'utf8') : ''
        const body = text.replace(/\r?\n$/, '')
        const headCount = existed && text.trim() ? parseCsvLine(text.split(/\r?\n/)[0]).length : 0
        if (existed && headCount > 0) {
          for (const l of lines) {
            const cells = parseCsvLine(l)
            if (cells.length !== headCount) {
              return `存在行列数与表头(${headCount} 列)不一致,已中止,请检查待追加内容:「${l.slice(0, 60)}」`
            }
          }
        }
        const add = lines.join('\n')
        writeFileSync(jail, `${body ? `${body}\n` : ''}${add}\n`, 'utf8')
        wsLog.info(`CSV 追加 ${args?.path} rows=${lines.length}`)
        return `已追加 ${lines.length} 行到 ${args?.path}${headCount > 0 ? `(表头 ${headCount} 列)` : '(新建文件)'}`
      } catch (e) {
        return `写入失败:${e instanceof Error ? e.message : String(e)}`
      }
    }
  )
)

/** 工作表名安全化 */
function sheetNameSafe(n: string): string {
  return (n || 'Sheet1').replace(/[\\/:*?[\]]/g, '_').slice(0, 31) || 'Sheet1'
}

WS_TOOLS.push(
  defOf(
    'xlsx_preview',
    {
      path: { type: 'string', required: true, desc: '相对 .xlsx 文件路径' },
      maxRows: { type: 'number', desc: '每表预览行数(默认 20)' }
    },
    '预览工作区 Excel(.xlsx):工作表清单 + 首表抽样(只读,不修改文件)。args: {"path":"台账.xlsx","maxRows":20}',
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
        if (!existsSync(jail) || !statSync(jail).isFile()) return `文件不存在:${args?.path}`
        const maxRows = Math.min(Math.max(Math.floor(Number(args?.maxRows) || 20), 1), 100)
        const ExcelJS = await import('exceljs')
        const wb = new ExcelJS.Workbook()
        await wb.xlsx.readFile(jail)
        const parts: string[] = []
        const ws0 = wb.worksheets[0]
        parts.push(`工作簿:${args?.path} · ${wb.worksheets.length} 个工作表`)
        parts.push(`工作表:${wb.worksheets.map((w) => `${w.name}(${w.rowCount} 行)`).join('、')}`)
        if (ws0) {
          const rows: string[][] = []
          ws0.eachRow({ includeEmpty: false }, (row) => {
            rows.push((row.values as Array<unknown>).slice(1).map((v) => String(v ?? '')))
          })
          parts.push(`—— ${ws0.name} 前 ${Math.min(rows.length, maxRows)} 行 ——`)
          rows.slice(0, maxRows).forEach((r, i) => parts.push(`${i + 1}: ${r.join(' | ')}`))
        }
        return parts.join('\n')
      } catch (e) {
        wsLog.error(`xlsx 预览失败 ${args?.path}`, e)
        return `xlsx 读取失败:${e instanceof Error ? e.message : String(e)}(仅支持标准 xlsx)`
      }
    }
  ),
  defOf(
    'xlsx_write',
    {
      path: { type: 'string', required: true, desc: '相对 .xlsx 输出路径(新建)' },
      rows: {
        type: 'string',
        required: true,
        desc: 'JSON 二维数组字符串,如 [["列1","列2"],["值1","值2"]]'
      },
      sheet: { type: 'string', desc: '工作表名(默认 Sheet1)' }
    },
    '生成工作区 Excel 文件(写操作,需审批):按 JSON 二维数组写入新工作簿;' +
      '只支持新建(已存在则失败)。args: {"path":"输出.xlsx","rows":"[[...],[...]]"}',
    async (ctx, args) => {
      const root = rootOf(ctx)
      if (!root) return NO_WS
      const p = String(args?.path ?? '')
        .trim()
        .replace(/\\/g, '/')
      const jail = jailPath(root, p)
      if (!jail) return '路径越界。'
      if (existsSync(jail)) return `文件已存在:${p}(xlsx_write 只支持新建)。`
      let rows: unknown[][]
      try {
        const parsed = JSON.parse(String(args?.rows ?? '')) as unknown
        if (
          !Array.isArray(parsed) ||
          parsed.length === 0 ||
          parsed.some((r) => !Array.isArray(r))
        ) {
          return 'rows 需为非空二维数组 JSON。'
        }
        rows = parsed as unknown[][]
      } catch {
        return 'rows 不是合法 JSON 二维数组。'
      }
      try {
        const ExcelJS = await import('exceljs')
        const wb = new ExcelJS.Workbook()
        const ws = wb.addWorksheet(sheetNameSafe(String(args?.sheet ?? '')))
        ws.addRows(rows)
        await wb.xlsx.writeFile(jail)
        wsLog.info(`xlsx 生成 ${p} rows=${rows.length}`)
        return `已生成 ${p}(${rows.length} 行 × ${rows[0].length} 列)`
      } catch (e) {
        wsLog.error(`xlsx 生成失败 ${p}`, e)
        return `生成失败:${e instanceof Error ? e.message : String(e)}`
      }
    }
  ),
  defOf(
    'site_scaffold',
    {
      dir: { type: 'string', required: true, desc: '相对目录名(将新建,字母/数字/_/-)' },
      pages: { type: 'number', desc: '页面数:1=单页,>1=多页含 about 等(默认 1)' }
    },
    '在工作区创建静态网站骨架(写操作,需审批):index.html + style.css + app.js + README,' +
      '多页模式额外生成 about.html 等。之后用 workspace_write 填充内容。args: {"dir":"landing","pages":1}',
    async (ctx, args) => {
      const root = rootOf(ctx)
      if (!root) return NO_WS
      const name = String(args?.dir ?? '').trim()
      if (!/^[A-Za-z0-9_-]{1,60}$/.test(name)) return '目录名仅支持字母/数字/_/-,长度≤60。'
      const pages = Math.min(Math.max(Math.floor(Number(args?.pages) || 1), 1), 6)
      const indexJail = jailPath(root, `${name}/index.html`)
      if (!indexJail) return '路径越界。'
      if (existsSync(jailPath(root, name) as string)) return `目录已存在:${name}`
      const base = String(args?.dir ?? '')
      const files: Record<string, string> = {
        'index.html': `<!doctype html>\n<html lang="zh-CN">\n<head>\n  <meta charset="utf-8" />\n  <meta name="viewport" content="width=device-width,initial-scale=1" />\n  <title>${name}</title>\n  <link rel="stylesheet" href="style.css" />\n</head>\n<body>\n  <header><h1>${name}</h1><nav><a href="index.html">首页</a></nav></header>\n  <main>\n    <p>在这里开始填写你的页面内容。</p>\n  </main>\n  <script src="app.js"></script>\n</body>\n</html>\n`,
        'style.css': `:root{color-scheme:light dark}\nbody{margin:0;font-family:system-ui,sans-serif;line-height:1.6}\nheader{border-bottom:1px solid #ddd;padding:12px 24px}\nmain{max-width:760px;margin:24px auto;padding:0 16px}\n`,
        'app.js': `// ${name} 交互脚本\nconsole.log('${name} ready')\n`,
        'README.md': `# ${name}\n\n静态站点骨架(由工作区助手生成)。\n\n- 页面:${'index.html'}${
          pages > 1 ? '、about.html' : ''
        }\n- 样式:style.css\n- 脚本:app.js\n\n本地预览:直接双击 index.html,或起静态服务器。\n`
      }
      if (pages > 1) {
        files['about.html'] =
          `<!doctype html>\n<html lang="zh-CN">\n<head>\n  <meta charset="utf-8" />\n  <title>关于 · ${name}</title>\n  <link rel="stylesheet" href="style.css" />\n</head>\n<body>\n  <header><nav><a href="index.html">首页</a> · 关于</nav></header>\n  <main><h1>关于</h1><p>介绍这个站点。</p></main>\n</body>\n</html>\n`
      }
      try {
        mkdirSync(jailPath(root, name) as string)
        for (const [f, content] of Object.entries(files)) {
          const fp = jailPath(root, `${base}/${f}`)
          if (!fp) continue
          writeFileSync(fp, content, 'utf8')
        }
        wsLog.info(`站点脚手架 ${base} pages=${pages}`)
        const tree = Object.keys(files)
          .map((f) => `- ${base}/${f}`)
          .join('\n')
        return `已创建站点骨架:\n${tree}\n\n可继续用 workspace_read/workspace_write 完善内容。`
      } catch (e) {
        wsLog.error(`站点脚手架失败 ${base}`, e)
        return `创建失败:${e instanceof Error ? e.message : String(e)}`
      }
    }
  )
)

export function findWsTool(name: string): ToolDef | undefined {
  return WS_TOOLS.find((t) => t.name === name)
}

/** 写/危险类工具:需要逐次审批 */
const WRITE_NAMES = new Set([
  'workspace_write',
  'workspace_mkdir',
  'workspace_delete',
  'csv_append',
  'xlsx_write',
  'site_scaffold'
])
export function isWsWriteTool(name: string): boolean {
  return WRITE_NAMES.has(name)
}

// 写类工具统一标记 confirm:引擎按「工具审批策略」(人工审批 / 完全访问)决定确认或直通,
// 工作台与飞书/IM 两条链路共用同一判定
for (const t of WS_TOOLS) {
  if (WRITE_NAMES.has(t.name)) t.confirm = true
}
